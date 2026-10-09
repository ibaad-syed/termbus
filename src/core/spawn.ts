import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { shellQuote } from '../restore/resume-command.js'

/**
 * HQ's conductor can ask the bridge to start a new agent pane. The request
 * comes from a remote service driven by an LLM that reads untrusted text, so
 * it is checked hard here, on the Mac: only claude/codex, no flags at all
 * (spawned agents run with their normal permission prompts, which surface in
 * HQ as approval cards), an existing directory inside the user's home, a
 * quoted first prompt, and a rate limit.
 */

export interface SpawnRequest {
  agent: 'claude' | 'codex'
  cwd: string
  name: string | null
  prompt: string | null
}

export const SPAWN_LIMIT = 5
export const SPAWN_WINDOW_MS = 10 * 60_000
const MAX_PROMPT = 4000
const MAX_NAME = 80

export function parseSpawnRequest(
  payload: string | null,
  opts: { home?: string; realpath?: (p: string) => string; isDir?: (p: string) => boolean } = {},
): SpawnRequest | { error: string } {
  const home = opts.home ?? homedir()
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p))
  const isDir = opts.isDir ?? ((p: string) => statSync(p).isDirectory())
  let j: Record<string, unknown>
  try {
    j = JSON.parse(payload ?? '')
  } catch {
    return { error: 'spawn payload is not JSON' }
  }
  if (j.agent !== 'claude' && j.agent !== 'codex') return { error: 'agent must be "claude" or "codex"' }
  if (typeof j.cwd !== 'string' || !isAbsolute(j.cwd)) return { error: 'cwd must be an absolute path' }
  let cwd: string
  try {
    cwd = realpath(j.cwd)
    if (!isDir(cwd)) return { error: `not a directory: ${j.cwd}` }
  } catch {
    return { error: `no such directory: ${j.cwd}` }
  }
  const realHome = (() => {
    try {
      return realpath(home)
    } catch {
      return home
    }
  })()
  if (cwd !== realHome && !cwd.startsWith(realHome + sep)) return { error: 'cwd must be inside your home directory' }
  if (j.name != null && (typeof j.name !== 'string' || j.name.length > MAX_NAME)) return { error: `name must be text ≤ ${MAX_NAME} chars` }
  if (j.prompt != null && (typeof j.prompt !== 'string' || j.prompt.length > MAX_PROMPT)) return { error: `prompt must be text ≤ ${MAX_PROMPT} chars` }
  return {
    agent: j.agent,
    cwd,
    name: typeof j.name === 'string' && j.name.trim() ? j.name.trim() : null,
    prompt: typeof j.prompt === 'string' && j.prompt.trim() ? j.prompt : null,
  }
}

/** The shell line a spawned pane runs: no flags, and the prompt ALWAYS
 *  prefixed — as a bare first argument it could parse as an option
 *  (`--yolo`), a subcommand (`update`, `logout`, `exec`), or a slash/bang
 *  command (`/…`, `!…`). "Task: …" is always just text. */
export function spawnShellLine(req: SpawnRequest): string {
  const prompt = req.prompt ? `Task: ${req.prompt.trimStart()}` : null
  const argv = [req.agent, ...(prompt ? [prompt] : [])]
  return `cd ${shellQuote(req.cwd)} && ${argv.map(shellQuote).join(' ')}`
}

export class SpawnLimiter {
  private times: number[] = []
  constructor(
    private readonly limit = SPAWN_LIMIT,
    private readonly windowMs = SPAWN_WINDOW_MS,
    private readonly file: string | null = null,
  ) {
    if (file) {
      try {
        const t = JSON.parse(readFileSync(file, 'utf8')) as unknown
        if (Array.isArray(t)) this.times = t.filter((x): x is number => typeof x === 'number')
      } catch {
        // no history yet
      }
    }
  }

  /** Survives bridge restarts (a crash loop must not reset the limit). */
  static persistent(): SpawnLimiter {
    return new SpawnLimiter(SPAWN_LIMIT, SPAWN_WINDOW_MS, join(homedir(), '.termbus', 'spawn-times.json'))
  }

  /** Records the spawn and returns true if allowed. */
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs)
    if (this.times.length >= this.limit) return false
    this.times.push(now)
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(this.file, JSON.stringify(this.times))
      } catch {
        // best effort
      }
    }
    return true
  }
}
