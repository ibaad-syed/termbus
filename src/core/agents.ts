import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The agent registry: every agent TUI termbus knows, in one place. An entry
 * says how to recognise the agent's process, how to read its screen
 * (busy / awaiting-input / idle), whether its composer queues input typed
 * mid-turn, where its transcript lives, and how to resume it after a restart.
 *
 * Built-in entries: claude, codex, devin. More can be declared in
 * ~/.termbus/agents.json (TERMBUS_AGENTS_FILE overrides the path) — those are
 * screen-only: no transcript, no native queue, no question dialogs, no resume.
 */

export type TranscriptSource = 'claude' | 'codex' | 'devin' | 'screen'

export interface ResumeDef {
  /** argv for resuming `sessionId`, given the original binary as typed */
  head(bin: string, sessionId: string): string[]
  /** flags carried into the resumed process (posture: model, permissions…) */
  keep: { bool: Set<string>; value: Set<string> }
  /** flags that select WHICH conversation (or carry a prompt); replaced by the saved id */
  strip: { bool: Set<string>; value: Set<string>; optional: Set<string> }
  /** what a session id looks like, so `--resume <id>` is told apart from prompt text */
  sessionId: RegExp
  /** a bare subcommand that selects the conversation (`codex resume <id>`) */
  subcommand?: string
  /** a token after which everything is prompt text (`devin -- <prompt>`) */
  endOfFlags?: string
}

export interface ScreenDef {
  /** transient "working" chrome, matched against the footer */
  busy: RegExp[]
  /** modal dialogs (permission prompts, pickers), matched against the footer */
  prompt: RegExp[]
  /**
   * Positive idle chrome, matched against the last non-empty lines. When set,
   * a screen that is neither busy, at a prompt, nor idle by these markers
   * reads as busy — an unrecognised screen is never typed into.
   */
  idle?: RegExp[]
  /** interactive question dialogs (footer must close the screen, body nearby) */
  question?: { footer: RegExp; body: RegExp }
  /**
   * Extra gate for messages typed in from HQ (remote, unattended): must match
   * the last non-empty lines, on top of the pane reading idle. For agents
   * whose screen detection is not calibrated yet.
   */
  remoteReady?: { pattern: RegExp; refusal: string }
}

export interface AgentDef {
  id: string
  label: string
  /** process base names (`claude`, `/opt/bin/codex` → `codex`) */
  commands: string[]
  /** helper processes sharing a command name, not the TUI (`devin acp`) — args after the binary */
  exclude?: (args: string[]) => boolean
  screen: ScreenDef
  transcript: TranscriptSource
  /** the composer accepts a message mid-turn and handles it itself */
  nativeQueue: boolean
  resume?: ResumeDef
  builtin: boolean
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CLAUDE: AgentDef = {
  id: 'claude',
  label: 'Claude Code',
  commands: ['claude'],
  builtin: true,
  transcript: 'claude',
  nativeQueue: true,
  screen: {
    busy: [/esc to interrupt/i, /ctrl\+c to stop/i, /[✻✽✶✢]\s+\S+ing…/],
    prompt: [/[❯›]\s*\d+\.\s/, /enter to confirm/i, /do you want to (proceed|make|create|allow)/i],
    question: { footer: /Enter to select · (Tab\/Arrow keys|↑\/↓) to navigate/, body: /[☐☒]/ },
  },
  resume: {
    head: (bin, id) => [bin, '--resume', id],
    sessionId: UUIDISH,
    keep: {
      bool: new Set([
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--chrome',
        '--no-chrome',
        '--ide',
        '--verbose',
        '--brief',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ]),
      value: new Set([
        '--model',
        '--permission-mode',
        '--add-dir',
        '--effort',
        '--fallback-model',
        '--agent',
        '--settings',
        '--mcp-config',
        '--plugin-dir',
        '--setting-sources',
        '--allowedTools',
        '--allowed-tools',
        '--disallowedTools',
        '--disallowed-tools',
      ]),
    },
    strip: {
      bool: new Set(['-c', '--continue', '--fork-session']),
      value: new Set(['--session-id']),
      optional: new Set(['-r', '--resume']),
    },
  },
}

const CODEX: AgentDef = {
  id: 'codex',
  label: 'Codex',
  commands: ['codex'],
  builtin: true,
  transcript: 'codex',
  nativeQueue: true,
  screen: {
    busy: [/esc to interrupt/i, /▌\s*Working/i],
    // codex renders its selector as › (single right angle), not ❯ — seen live on
    // its trust-directory dialog, which also says "Press enter to continue"
    prompt: [/[❯›]\s*\d+\.\s/, /press enter to (confirm|continue)/i, /would you like to (make|proceed|run|approve)/i, /do you trust/i],
    question: { footer: /enter to submit (answer|all)/, body: /Question \d+\/\d+/ },
  },
  resume: {
    head: (bin, id) => [bin, 'resume', id],
    sessionId: UUIDISH,
    subcommand: 'resume',
    keep: {
      bool: new Set([
        '--yolo',
        '--dangerously-bypass-approvals-and-sandbox',
        '--full-auto',
        '--search',
        '--oss',
        '--no-alt-screen',
        '--approve-for-me',
      ]),
      value: new Set([
        '-m',
        '--model',
        '-p',
        '--profile',
        '-c',
        '--config',
        '-s',
        '--sandbox',
        '-a',
        '--ask-for-approval',
        '--add-dir',
        '--enable',
        '--disable',
        '--local-provider',
      ]),
    },
    strip: {
      bool: new Set(['--last', '--all']),
      value: new Set(['-C', '--cd']),
      optional: new Set(),
    },
  },
}

/**
 * Devin CLI (verified against v3000.11.3 on a live pane, read-only).
 *
 * VERIFIED: the idle screen — logo, plan line, then the composer `❭ …`
 * between two `─` rules and a model/shortcuts footer as the last line.
 *
 * UNVERIFIED (no busy or permission screen has been observed yet): the busy
 * and prompt markers below come from UI strings inside the Devin binary
 * ("(esc twice to interrupt)", "Guide Devin while it works", "Press Enter to
 * send queued messages now", "(Approve once)", "Tool approval pending", …) and
 * its bundled docs ("Yes, always allow `<cmd>` commands in …"). Calibrating =
 * paste a real screen into tests/devin-screen.test.ts as a fixture and adjust
 * the regexes here until it classifies.
 *
 * Until calibrated, the idle markers make detection conservative: a Devin
 * screen that is not recognisably idle reads as busy, so nothing is typed into
 * it without --wait/--force.
 */
const DEVIN: AgentDef = {
  id: 'devin',
  label: 'Devin',
  commands: ['devin'],
  // the TUI spawns `devin acp` (its ACP server) on the same tty
  exclude: (args) => args[0] === 'acp',
  builtin: true,
  transcript: 'devin',
  // UNVERIFIED: the binary mentions queued messages, but queueing has not been
  // seen working, so a busy Devin is refused (use --wait) rather than typed into
  nativeQueue: false,
  screen: {
    busy: [/esc (again|twice) to interrupt/i, /Guide Devin while it works/, /Press Enter to send queued messages/i],
    prompt: [
      /[❯›]\s*\d+\.\s/,
      /\(Approve once\)/,
      /Yes, always allow/,
      /(Tool approval|Network permission|Question) pending/,
      /Input needed/,
      /Describe change to command/,
      /do you want to (proceed|allow|run|make|create)/i,
    ],
    // the composer (`❭ …`, possibly wrapped) between two rules, then at most
    // one footer line, closes the screen
    idle: [/─{20,}\n❭[^\n]*(\n(?!─)[^\n]*){0,8}\n─{20,}(\n[^\n]*)?$/],
    // Until busy detection is calibrated, HQ sends need the EMPTY composer:
    // its placeholder is only shown when nothing is typed and no turn runs
    // (verified on the live idle screen). While busy it reads "Guide Devin
    // while it works" (binary string, unverified).
    remoteReady: {
      pattern: /─{20,}\n❭ Ask Devin to [^\n]*\n─{20,}(\n[^\n]*)?$/,
      refusal: "Devin looks busy — try again when it's idle",
    },
  },
  resume: {
    head: (bin, id) => [bin, '-r', id],
    // Devin session ids are word pairs (`adaptive-hardcover`); uuids accepted too
    sessionId: /^([a-z0-9]+(-[a-z0-9]+)+)$/i,
    endOfFlags: '--',
    keep: { bool: new Set(['--sandbox']), value: new Set(['--model', '--permission-mode']) },
    strip: {
      bool: new Set(['-c', '--continue', '-p', '--print']),
      value: new Set(['--prompt-file']),
      optional: new Set(['-r', '--resume']),
    },
  },
}

export const BUILTIN_AGENTS: readonly AgentDef[] = [CLAUDE, CODEX, DEVIN]

// ---------------------------------------------------------------------------
// Config-defined agents (~/.termbus/agents.json)

export const MAX_PATTERN_CHARS = 200

/**
 * Programs that are never an agent TUI: shells, interpreters and REPLs,
 * remote shells, database clients, privilege/process wrappers, container
 * tools, multiplexers, editors and pagers. Declaring (or marking) one as an
 * agent would let HQ type into it — around the exec consent tiers.
 */
export const NEVER_AGENT_COMMANDS: ReadonlySet<string> = new Set([
  // remote shells / transfer
  'ssh', 'mosh', 'telnet', 'et', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'scp', 'rsh',
  // shells
  'bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'login',
  // interpreters, package runners, REPLs
  'python', 'python3', 'python2', 'pip', 'pip3', 'node', 'deno', 'bun', 'npx', 'npm', 'pnpm', 'yarn',
  'ruby', 'irb', 'perl', 'php', 'lua', 'R', 'julia', 'osascript', 'swift',
  // database clients
  'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongo', 'mongosh',
  // privilege / process wrappers
  'sudo', 'su', 'doas', 'env', 'nohup', 'time', 'xargs', 'exec', 'nice', 'caffeinate',
  // containers / clusters
  'docker', 'podman', 'kubectl',
  // multiplexers
  'tmux', 'screen',
  // editors / pagers
  'vim', 'nvim', 'vi', 'emacs', 'nano', 'less', 'more', 'man',
])

export function isNeverAgentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = (first.split('/').pop() ?? first).replace(/^-/, '')
  return NEVER_AGENT_COMMANDS.has(base) || /^python\d/.test(base)
}

/** Patterns prone to catastrophic backtracking, refused at load: a
 *  quantified group that itself contains a quantifier ((a+)+, (x*y)*),
 *  and backreferences. A heuristic — it errs on the side of refusing. */
export function unsafePattern(src: string): string | null {
  if (/\((?:[^()\\]|\\.)*(?:[*+?]|\{\d)(?:[^()\\]|\\.)*\)(?:[*+]|\{\d)/.test(src)) return 'nested quantifier'
  if (/\\[1-9]|\\k</.test(src)) return 'backreference'
  return null
}
const ID = /^[a-z][a-z0-9-]{1,31}$/
const BASENAME = /^[A-Za-z0-9._+-]{1,64}$/

export function agentsFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_AGENTS_FILE ?? join(homedir(), '.termbus', 'agents.json')
}

function compile(list: unknown, what: string): RegExp[] {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error(`${what} must be a list of regex strings`)
  return list.map((s) => {
    if (typeof s !== 'string' || !s) throw new Error(`${what} entries must be non-empty strings`)
    if (s.length > MAX_PATTERN_CHARS) throw new Error(`${what} pattern longer than ${MAX_PATTERN_CHARS} chars`)
    const unsafe = unsafePattern(s)
    if (unsafe) throw new Error(`${what} pattern /${s}/ has a ${unsafe} (could hang on a long screen)`)
    try {
      return new RegExp(s, 'm')
    } catch {
      throw new Error(`${what} pattern /${s}/ does not compile`)
    }
  })
}

/** One agents.json entry → AgentDef, or an error message. */
export function parseAgentEntry(raw: unknown, taken: Set<string>): AgentDef | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'entry is not an object' }
  const e = raw as Record<string, unknown>
  const id = e.id
  if (typeof id !== 'string' || !ID.test(id)) return { error: `id ${JSON.stringify(id)} must match ${ID}` }
  const where = `agent "${id}"`
  if (BUILTIN_AGENTS.some((b) => b.id === id)) return { error: `${where}: "${id}" is built in` }
  if (taken.has(id)) return { error: `${where}: defined twice` }
  if (['shell', 'command', 'unknown'].includes(id)) return { error: `${where}: "${id}" is reserved` }
  const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 40) : id
  if (!Array.isArray(e.commands) || e.commands.length === 0 || !e.commands.every((c) => typeof c === 'string' && BASENAME.test(c))) {
    return { error: `${where}: commands must be a non-empty list of process names (no paths)` }
  }
  const never = (e.commands as string[]).filter((c) => isNeverAgentCommand(c))
  if (never.length) return { error: `${where}: ${never.join(', ')} is a shell/interpreter/wrapper, not an agent TUI` }
  if (e.nativeQueue !== undefined && typeof e.nativeQueue !== 'boolean') return { error: `${where}: nativeQueue must be true or false` }
  try {
    const busy = compile(e.busy, `${where} busy`)
    const prompt = compile(e.prompt, `${where} prompt`)
    const idle = compile(e.idle, `${where} idle`)
    // without positive idle chrome an unrecognised screen would read idle and
    // be typed into; with it, anything unrecognised reads busy
    if (idle.length === 0) return { error: `${where}: needs at least one "idle" pattern (the screen when it waits for input)` }
    return {
      id,
      label,
      commands: e.commands as string[],
      builtin: false,
      transcript: 'screen',
      nativeQueue: e.nativeQueue === true,
      screen: { busy, prompt, idle },
    }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/** Parse agents.json text. Never throws: bad entries become warnings. */
export function parseAgentsFile(text: string): { agents: AgentDef[]; warnings: string[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { agents: [], warnings: ['agents.json is not valid JSON — ignored'] }
  }
  if (!Array.isArray(json)) return { agents: [], warnings: ['agents.json must be a JSON array of agent types — ignored'] }
  const agents: AgentDef[] = []
  const warnings: string[] = []
  const taken = new Set<string>()
  for (const raw of json) {
    const r = parseAgentEntry(raw, taken)
    if ('error' in r) warnings.push(`agents.json: skipped — ${r.error}`)
    else {
      agents.push(r)
      taken.add(r.id)
    }
  }
  return { agents, warnings }
}

let cache: { path: string; mtimeMs: number; agents: AgentDef[] } | null = null

function configAgents(): AgentDef[] {
  const path = agentsFile()
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache = { path, mtimeMs: -1, agents: [] }
    return []
  }
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.agents
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // unreadable: treat as empty
  }
  const { agents, warnings } = parseAgentsFile(text)
  for (const w of warnings) console.error(`termbus: ${w}`)
  cache = { path, mtimeMs, agents }
  return agents
}

/** Forget the cached agents.json (tests; it is re-read on mtime change anyway). */
export function resetAgentRegistry(): void {
  cache = null
}

/** Built-ins first, then config-defined agents. */
export function allAgents(): AgentDef[] {
  return [...BUILTIN_AGENTS, ...configAgents()]
}

export function agentDef(kind: string): AgentDef | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === kind) ?? configAgents().find((a) => a.id === kind)
}

export function isAgentKind(kind: string): boolean {
  return agentDef(kind) !== undefined
}

export function agentLabel(kind: string): string | null {
  return agentDef(kind)?.label ?? null
}

/**
 * Which agent a process is, from its command line. Built-ins win a name clash
 * with config entries. `respectExclude: false` also claims helper processes
 * (`devin acp`) — for "is an agent above me" ancestry checks.
 */
export function agentForCommand(command: string, opts: { respectExclude?: boolean } = {}): AgentDef | undefined {
  const [first = '', ...args] = command.trim().split(/\s+/)
  const base = (first.split('/').pop() ?? first).replace(/^-/, '')
  if (!base) return undefined
  for (const a of allAgents()) {
    if (!a.commands.includes(base)) continue
    if (opts.respectExclude !== false && a.exclude?.(args)) return undefined
    return a
  }
  return undefined
}
