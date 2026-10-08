import type { AgentKind } from '../core/types.js'

/**
 * Flags worth carrying into the resumed process: they set the agent's posture
 * (permissions, model, sandbox, extra dirs). Everything else is dropped and
 * reported — notably positional prompts, which must never be re-sent. ps
 * joins argv with spaces, so values containing spaces cannot be recovered;
 * the allowlist keeps the reconstruction honest.
 */
const KEEP: Record<AgentKind, { bool: Set<string>; value: Set<string> }> = {
  claude: {
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
  codex: {
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
}

/** Flags that select WHICH conversation; replaced by the saved id. */
const STRIP: Record<AgentKind, { bool: Set<string>; value: Set<string>; optional: Set<string> }> = {
  claude: {
    bool: new Set(['-c', '--continue', '--fork-session']),
    value: new Set(['--session-id']),
    optional: new Set(['-r', '--resume']),
  },
  codex: {
    bool: new Set(['--last', '--all']),
    value: new Set(['-C', '--cd']),
    optional: new Set(),
  },
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildResumeArgv(
  kind: AgentKind,
  command: string,
  sessionId: string,
): { argv: string[]; dropped: string[] } {
  const [bin, ...rest] = command.trim().split(/\s+/)
  const keep = KEEP[kind]
  const strip = STRIP[kind]
  const kept: string[] = []
  const dropped: string[] = []
  let sawResume = false
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (kind === 'codex' && tok === 'resume' && !sawResume) {
      sawResume = true
      const next = rest[i + 1]
      if (next && !next.startsWith('-')) {
        // only a real session id proves this was the subcommand and not prompt
        // text ("resume x --yolo"); anything else makes the line ambiguous
        if (UUIDISH.test(next)) i++
        else dropped.push(tok)
      }
      continue
    }
    if (!tok.startsWith('-')) {
      dropped.push(tok) // positional: a prompt
      continue
    }
    const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok
    const inlineValue = tok.includes('=')
    if (strip.bool.has(name)) continue
    if (strip.value.has(name)) {
      if (!inlineValue) i++
      continue
    }
    if (strip.optional.has(name)) {
      const next = rest[i + 1]
      if (!inlineValue && next && !next.startsWith('-')) {
        if (UUIDISH.test(next)) i++
        else dropped.push(tok) // "--resume foo": a picker search term or prompt text — ambiguous
      }
      continue
    }
    if (keep.bool.has(name)) {
      kept.push(tok)
      continue
    }
    if (keep.value.has(name)) {
      kept.push(tok)
      if (!inlineValue && rest[i + 1] !== undefined) kept.push(rest[++i])
      continue
    }
    dropped.push(tok)
  }
  const head = kind === 'claude' ? [bin, '--resume', sessionId] : [bin, 'resume', sessionId]
  // Anything unrecognized means argv boundaries are unknowable (ps flattens
  // quoting): `codex "explain --yolo"` must not come back with --yolo. Only a
  // command line that parses entirely as known flags carries any of them.
  if (dropped.length > 0) return { argv: head, dropped: [...kept, ...dropped] }
  return { argv: [...head, ...kept], dropped }
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function restoreShellLine(cwd: string, argv: string[]): string {
  return `cd ${shellQuote(cwd)} && ${argv.map(shellQuote).join(' ')}`
}

/**
 * A launch script for a restored pane: runs in the user's login+interactive
 * shell (so PATH from their rc files — nvm, homebrew — is there), resumes the
 * agent, and leaves a normal shell behind when the agent exits. zsh/bash run
 * it as-is; other shells (fish's quoting differs) launch through zsh and then
 * hand over to the user's shell.
 */
export function launchScript(userShell: string, line: string): string {
  const base = userShell.split('/').pop() ?? ''
  const runner = base === 'zsh' || base === 'bash' ? userShell : '/bin/zsh'
  return `#!${runner} -il\nrm -f "$0"\n${line}\nexec ${shellQuote(userShell)} -il\n`
}
