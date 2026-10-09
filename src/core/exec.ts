import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, sep } from 'node:path'

/**
 * HQ's conductor can run commands on this Mac. Two tiers, enforced HERE (the
 * request comes from an LLM-driven service that reads untrusted text):
 *
 * - read-only argv commands on a fixed allowlist run directly, without a
 *   shell, hardened against repo-controlled code execution (git pagers,
 *   external diff drivers, textconv);
 * - anything else must arrive marked `approved` — HQ sets that only when the
 *   signed-in user tapped Approve on a card showing the exact command.
 *
 * Both run in the background (never in a pane), inside $HOME, with a timeout
 * and capped output.
 */

export const READONLY_TIMEOUT_MS = 20_000
export const APPROVED_TIMEOUT_MS = 120_000
export const OUTPUT_CAP = 16 * 1024

const GIT_SUBCOMMANDS = new Set(['status', 'log', 'branch', 'diff', 'show', 'remote'])

/** Why an argv is not on the read-only list, or null if it is. */
export function readOnlyViolation(argv: string[]): string | null {
  if (argv.length === 0) return 'empty command'
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'ps': {
      // no environment display (`-e`/`-E`/`e` print every process's env vars — API keys)
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '-o' || a === '-O' || a === '-p') {
          if (!/^[\w,=%-]+$/.test(args[i + 1] ?? '')) return 'ps option value not allowed'
          i++
        } else if (!/^-?[aAcmrSuwxXjlvTh]+$/.test(a)) return `ps option ${a} not allowed`
      }
      return null
    }
    case 'ls':
    case 'pwd':
    case 'df':
    case 'du':
    case 'uptime':
    case 'whoami':
    case 'uname':
      return null
    case 'lsof': {
      const a = args[0] === '-nP' ? args.slice(1) : args
      return a.length > 0 && a.every((x) => /^-(i|s)/.test(x) || /^-[nP]+$/.test(x)) ? null : 'lsof only with network options (-i…)'
    }
    case 'git': {
      const sub = args[0]
      if (!sub || !GIT_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not read-only-allowlisted`.trim()
      if (sub === 'remote' && !(args.length === 2 && args[1] === '-v')) return 'only `git remote -v`'
      if (sub === 'branch' && args.slice(1).some((x) => !/^-(a|r|v|vv|-list|-show-current|-all|-remotes)$/.test(x))) {
        return 'git branch only for listing'
      }
      if (args.some((x) => /^--(output|ext-diff|textconv|exec|no-index)/.test(x) || x === '-c')) return 'option not allowed'
      // `git show HEAD:path` prints file contents — reading files needs approval
      if (sub === 'show' && args.slice(1).some((x) => x.includes(':'))) return 'git show of file contents needs approval'
      return null
    }
    default:
      return `${cmd} is not on the read-only list`
  }
}

/** git with repo-controlled execution turned off. */
export function hardenGit(argv: string[]): string[] {
  if (argv[0] !== 'git') return argv
  const [, sub, ...rest] = argv
  const extra = sub === 'diff' || sub === 'show' || sub === 'log' ? ['--no-ext-diff', '--no-textconv'] : []
  return ['git', '--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', sub, ...extra, ...rest]
}

export type ExecRequest =
  | { kind: 'argv'; argv: string[]; cwd: string }
  | { kind: 'shell'; command: string; cwd: string; approvedBy: 'user' | 'auto' }

export const AUTO_EXEC_HINT = 'this Mac does not allow auto-approved commands — run `termbus bridge --allow-auto-exec` on it to enable Full auto'

export function parseExecRequest(
  payload: string | null,
  opts: { home?: string; realpath?: (p: string) => string; isDir?: (p: string) => boolean; allowAutoExec?: boolean } = {},
): ExecRequest | { error: string } {
  const home = opts.home ?? homedir()
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p))
  const isDir = opts.isDir ?? ((p: string) => statSync(p).isDirectory())
  let j: Record<string, unknown>
  try {
    j = JSON.parse(payload ?? '')
  } catch {
    return { error: 'exec payload is not JSON' }
  }
  if (typeof j.cwd !== 'string' || !isAbsolute(j.cwd)) return { error: 'cwd must be an absolute path' }
  let cwd: string
  try {
    cwd = realpath(j.cwd)
    if (!isDir(cwd)) return { error: `not a directory: ${j.cwd}` }
  } catch {
    return { error: `no such directory: ${j.cwd}` }
  }
  let realHome = home
  try {
    realHome = realpath(home)
  } catch {
    // keep as given
  }
  if (cwd !== realHome && !cwd.startsWith(realHome + sep)) return { error: 'cwd must be inside your home directory' }
  if (Array.isArray(j.argv)) {
    if (!j.argv.every((a) => typeof a === 'string') || j.argv.length > 64) return { error: 'argv must be strings' }
    const why = readOnlyViolation(j.argv as string[])
    if (why) return { error: `not allowed without approval: ${why}` }
    return { kind: 'argv', argv: hardenGit(j.argv as string[]), cwd }
  }
  if (typeof j.command === 'string') {
    // "user": tapped Approve in HQ. "auto": HQ's Full auto setting — honoured
    // only if THIS Mac opted in locally, so a remote setting alone (or a
    // stolen HQ session/token) can never make it run commands unattended.
    const by = j.approved === true ? 'user' : j.approved
    if (by !== 'user' && by !== 'auto') return { error: 'shell commands need the user’s approval in HQ' }
    if (by === 'auto' && !opts.allowAutoExec) return { error: AUTO_EXEC_HINT }
    if (!j.command.trim() || j.command.length > 4000) return { error: 'command must be 1–4000 chars' }
    return { kind: 'shell', command: j.command, cwd, approvedBy: by }
  }
  return { error: 'exec needs argv or command' }
}

const cap = (s: string) => (Buffer.byteLength(s) > OUTPUT_CAP ? Buffer.from(s).subarray(0, OUTPUT_CAP).toString('utf8') : s)

export async function runExec(
  req: ExecRequest,
  shell: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  const [file, args] = req.kind === 'argv' ? [req.argv[0], req.argv.slice(1)] : [shell, ['-lc', req.command]]
  const timeout = req.kind === 'argv' ? READONLY_TIMEOUT_MS : APPROVED_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: req.cwd, timeout, maxBuffer: 4 * OUTPUT_CAP, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat' } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null
        const out = String(stdout ?? '')
        const errOut = String(stderr ?? '') + (e && !stderr && typeof e.code === 'string' ? e.message : '')
        resolve({
          exitCode: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: cap(out),
          stderr: cap(errOut),
          truncated: Buffer.byteLength(out) > OUTPUT_CAP || Buffer.byteLength(errOut) > OUTPUT_CAP || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          timedOut: !!e?.killed && e.signal === 'SIGTERM',
        })
      },
    )
  })
}
