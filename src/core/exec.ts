import { execFile, spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

/**
 * HQ's conductor can run commands on this Mac. Two tiers, enforced HERE (the
 * request comes from an LLM-driven service that reads untrusted text):
 *
 * - read-only argv commands on a fixed allowlist run directly, without a
 *   shell, hardened against repo-controlled code execution (git pagers,
 *   external diff drivers, textconv);
 * - anything else must arrive marked `approved` — by the signed-in user's tap
 *   on a card showing the exact command, or by HQ's Full auto setting — AND
 *   this Mac must have opted in locally (--allow-exec / --allow-auto-exec),
 *   since anyone holding the HQ session could tap Approve.
 *
 * Both run in the background (never in a pane), inside $HOME, with a timeout
 * that kills the whole process group, capped output, credentials redacted
 * (output goes to a model provider and is stored), and the bridge's own
 * secret removed from the environment.
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
      // network sockets only: at least one -i, and nothing but -i/-s/-n/-P
      const ok = args.some((x) => x.startsWith('-i')) && args.every((x) => /^-(i|s)/.test(x) || /^-[nP]+$/.test(x))
      return ok ? null : 'lsof only with network options (-i…)'
    }
    case 'git': {
      const sub = args[0]
      if (!sub || !GIT_SUBCOMMANDS.has(sub)) return `git ${sub ?? ''} is not read-only-allowlisted`.trim()
      if (sub === 'remote' && !(args.length === 2 && args[1] === '-v')) return 'only `git remote -v`'
      if (sub === 'branch' && args.slice(1).some((x) => !/^-(a|r|v|vv|-list|-show-current|-all|-remotes)$/.test(x))) {
        return 'git branch only for listing'
      }
      if (args.some((x) => /^--(output|ext-diff|textconv|exec|no-index|show-signature)/.test(x) || x === '-c')) return 'option not allowed'
      if (args.some((x) => /%G/.test(x))) return 'signature formats run gpg'
      // revisions and in-repo paths only: no absolute paths, no `..` segments,
      // no `~` (outside a repo `git diff a b` silently reads ANY two files)
      for (const x of args.slice(1)) {
        if (x.startsWith('-')) continue
        if (x.startsWith('/') || x.startsWith('~') || x.split('/').includes('..')) return `path ${x} is outside the repo`
      }
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
  // submodules have their own config (filters etc.): never descend into them
  const noSub = sub === 'status' || sub === 'diff' ? ['--ignore-submodules=all'] : []
  return [
    'git', '--no-pager',
    '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=',
    '-c', 'log.showSignature=false', '-c', 'gpg.program=false',
    '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false',
    sub, ...extra, ...noSub, ...rest,
  ]
}

/**
 * Repo-local git config can make even `git status`/`git diff` run programs
 * (clean filters, diff drivers, fsmonitor, gpg, pagers…). Whoever writes the
 * repo writes that config, so a repo that sets any of these is not
 * "read-only" — its git commands need the user's approval. The user's own
 * global/system config (git-lfs etc.) is trusted as before.
 */
const RISKY_LOCAL_KEY = /^(filter\.|diff\.[^=]*\.(command|textconv)=|diff\.external=|gpg\.|core\.(fsmonitor|pager|sshcommand|editor|askpass|hookspath|gitproxy)=|credential\.|pager\.|include\.|includeif\.)/i

export function riskyLocalGitConfig(listing: string): string | null {
  for (const line of listing.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const scope = line.slice(0, tab)
    const kv = line.slice(tab + 1)
    if ((scope === 'local' || scope === 'worktree' || scope === 'command') && RISKY_LOCAL_KEY.test(kv)) {
      return kv.split('=')[0]
    }
  }
  return null
}

function gitOut(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, env: execEnv() }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }))
  })
}

/**
 * Why a git command is NOT read-only in this directory, or null if it is.
 * Fails closed: if anything can't be determined, it needs approval.
 * - not inside a work tree: `git diff a b` would read arbitrary files;
 * - submodules: each has its own config, which could run programs;
 * - repo-local config that runs programs (see riskyLocalGitConfig).
 */
export async function gitConfigRisk(cwd: string): Promise<string | null> {
  const inside = await gitOut(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') return 'not inside a git work tree'
  const top = await gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return 'could not inspect the repo'
  try {
    statSync(join(top.out.trim(), '.gitmodules'))
    return 'the repo has submodules (each with its own config)'
  } catch {
    // no submodules
  }
  const cfg = await gitOut(cwd, ['config', '--list', '--includes', '--show-scope'])
  if (!cfg.ok) return 'could not inspect the repo\'s git config'
  return riskyLocalGitConfig(cfg.out)
}

export type ExecRequest =
  | { kind: 'argv'; argv: string[]; cwd: string }
  | { kind: 'shell'; command: string; cwd: string; approvedBy: 'user' | 'auto' }

export const EXEC_HINT = 'this Mac does not run commands from HQ — run `termbus bridge --allow-exec` on it to allow commands you approve'
export const AUTO_EXEC_HINT = 'this Mac does not allow auto-approved commands — run `termbus bridge --allow-auto-exec` on it to enable Full auto'

export function parseExecRequest(
  payload: string | null,
  opts: {
    home?: string
    realpath?: (p: string) => string
    isDir?: (p: string) => boolean
    /** local opt-in for commands the user approved in HQ */
    allowExec?: boolean
    /** local opt-in for HQ's Full auto (implies allowExec) */
    allowAutoExec?: boolean
  } = {},
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
    // "user": tapped Approve in HQ. "auto": HQ's Full auto setting. Either is
    // honoured only if THIS Mac opted in locally (--allow-exec /
    // --allow-auto-exec): anyone holding the HQ session could tap Approve,
    // so remote approval alone must never be enough to run commands here.
    const by = j.approved === true ? 'user' : j.approved
    if (by !== 'user' && by !== 'auto') return { error: 'shell commands need the user’s approval in HQ' }
    if (by === 'auto' && !opts.allowAutoExec) return { error: AUTO_EXEC_HINT }
    if (by === 'user' && !opts.allowExec && !opts.allowAutoExec) return { error: EXEC_HINT }
    if (!j.command.trim() || j.command.length > 4000) return { error: 'command must be 1–4000 chars' }
    return { kind: 'shell', command: j.command, cwd, approvedBy: by }
  }
  return { error: 'exec needs argv or command' }
}

const cap = (s: string) => (Buffer.byteLength(s) > OUTPUT_CAP ? Buffer.from(s).subarray(0, OUTPUT_CAP).toString('utf8') : s)

/**
 * Mask credentials before output leaves this Mac: tokens in URLs
 * (`https://user:tok@host`), `--token x` / `--secret=x` style flags, and
 * `SOMETHING_TOKEN=x` style assignments (ps shows command lines and envs).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1$2:***@')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]{16,})@/gi, '$1***@')
    .replace(/(--?(?:token|secret|password|passwd|pass|api[-_]?key|auth|access[-_]?key|bearer)(?:=|\s+))(\S+)/gi, '$1***')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)=(\S+)/g, '$1=***')
    .replace(/\b([a-z0-9_]*(?:token|secret|password|passwd|api_?key|apikey|access_key|private_key|authtoken)[a-z0-9_]*)=(\S+)/gi, '$1=***')
    .replace(/("(?:[a-z0-9_]*(?:token|secret|password|passwd|api_?key|apikey|access_?key|private_?key|authtoken))"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/\b((?:Bearer|token|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
    .replace(/\b(sk|pk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|vck|vcp|npm|glpat|AKIA|ASIA)[-_]?[A-Za-z0-9_-]{16,}/g, '$1_***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '-----BEGIN PRIVATE KEY----- *** (redacted)')
}

/** Environment for commands: no termbus/HQ credentials. */
export function execEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', PAGER: 'cat' }
  for (const k of Object.keys(out)) if (/^TERMBUS_/.test(k)) delete out[k]
  return out
}

export async function runExec(
  req: ExecRequest,
  shell: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  const [file, args] = req.kind === 'argv' ? [req.argv[0], req.argv.slice(1)] : [shell, ['-lc', req.command]]
  const timeout = opts.timeoutMs ?? (req.kind === 'argv' ? READONLY_TIMEOUT_MS : APPROVED_TIMEOUT_MS)
  return new Promise((resolve) => {
    // own process group, so a timeout kills the command's children too
    const child = spawn(file, args, { cwd: req.cwd, env: execEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let truncated = false
    let timedOut = false
    const take = (acc: string, chunk: Buffer) => {
      if (Buffer.byteLength(acc) >= OUTPUT_CAP * 2) {
        truncated = true
        return acc
      }
      return acc + chunk.toString('utf8')
    }
    child.stdout.on('data', (c: Buffer) => (out = take(out, c)))
    child.stderr.on('data', (c: Buffer) => (err = take(err, c)))
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => kill('SIGKILL'), 2000).unref()
    }, timeout)
    const finish = (code: number) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        stdout: cap(redactSecrets(out)),
        stderr: cap(redactSecrets(err)),
        truncated: truncated || Buffer.byteLength(out) > OUTPUT_CAP || Buffer.byteLength(err) > OUTPUT_CAP,
        timedOut,
      })
    }
    let done = false
    const settle = (code: number) => {
      if (done) return
      done = true
      child.stdout.destroy()
      child.stderr.destroy()
      finish(code)
    }
    child.on('error', (e) => {
      err += e.message
      settle(127)
    })
    // 'close' waits for every holder of the pipes — a detached grandchild can
    // keep them open forever. Settle shortly after the command itself exits.
    child.on('exit', (code, signal) => setTimeout(() => settle(code ?? (signal ? 128 : 1)), 500).unref())
    child.on('close', (code, signal) => settle(code ?? (signal ? 128 : 1)))
  })
}
