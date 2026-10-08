import { execFile } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentKind } from '../core/types.js'

const execFileP = promisify(execFile)

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Claude Code writes ~/.claude/sessions/<pid>.json for every interactive
 * process and keeps sessionId current (it changes on /clear). The file can
 * outlive its process, so a known start time must match — pid reuse would
 * otherwise attach a dead conversation to an unrelated process.
 */
export function claudeSessionFromFile(
  raw: string,
  procStart: string | string[] | null,
): { sessionId: string; cwd: string | null; name: string | null } | null {
  let j: { sessionId?: unknown; cwd?: unknown; name?: unknown; procStart?: unknown }
  try {
    j = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof j.sessionId !== 'string' || !j.sessionId) return null
  // Claude Code records the start time in UTC; callers may pass several renderings
  const accepted = procStart === null ? [] : Array.isArray(procStart) ? procStart : [procStart]
  if (accepted.length > 0 && typeof j.procStart === 'string' && !accepted.some((p) => squash(p) === squash(j.procStart as string))) {
    return null
  }
  return {
    sessionId: j.sessionId,
    cwd: typeof j.cwd === 'string' ? j.cwd : null,
    name: typeof j.name === 'string' ? j.name : null,
  }
}

/**
 * A Codex TUI keeps its rollout files open: its own thread plus one per
 * subagent (those carry parent_thread_id). The conversation to resume is the
 * top-level thread; if several, the most recently written.
 */
export function codexMainThread(
  candidates: Array<{ mtimeMs: number; meta: Record<string, unknown> }>,
): { sessionId: string; cwd: string | null } | null {
  const top = candidates
    .filter((c) => typeof c.meta.id === 'string' && !c.meta.parent_thread_id)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  if (!top) return null
  return { sessionId: top.meta.id as string, cwd: typeof top.meta.cwd === 'string' ? top.meta.cwd : null }
}

/** The process start time as ps renders it, in UTC and in local time. */
async function procStartOf(pid: number): Promise<string[] | null> {
  const out: string[] = []
  for (const env of [{ ...process.env, TZ: 'UTC' }, process.env]) {
    try {
      const { stdout } = await execFileP('ps', ['-o', 'lstart=', '-p', String(pid)], { env })
      if (stdout.trim()) out.push(stdout.trim())
    } catch {
      // process gone
    }
  }
  return out.length > 0 ? out : null
}

async function processCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

async function firstLine(path: string): Promise<string> {
  const fh = await open(path, 'r')
  try {
    // session_meta lines embed base instructions (~20KB); cap the read
    const buf = Buffer.alloc(512 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const s = buf.toString('utf8', 0, bytesRead)
    const nl = s.indexOf('\n')
    return nl >= 0 ? s.slice(0, nl) : s
  } finally {
    await fh.close()
  }
}

async function codexOpenRollouts(pid: number): Promise<Array<{ mtimeMs: number; meta: Record<string, unknown> }>> {
  let stdout: string
  try {
    ;({ stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-Fn'], { maxBuffer: 8 * 1024 * 1024 }))
  } catch {
    return []
  }
  const paths = stdout
    .split('\n')
    .filter((l) => l.startsWith('n') && /\/rollout-[^/]+\.jsonl$/.test(l))
    .map((l) => l.slice(1))
  const out: Array<{ mtimeMs: number; meta: Record<string, unknown> }> = []
  for (const p of new Set(paths)) {
    try {
      const line = JSON.parse(await firstLine(p)) as { type?: string; payload?: Record<string, unknown> }
      if (line.type !== 'session_meta' || !line.payload) continue
      out.push({ mtimeMs: (await stat(p)).mtimeMs, meta: line.payload })
    } catch {
      // unreadable or rotated mid-scan
    }
  }
  return out
}

export interface AgentIdentity {
  sessionId: string | null
  cwd: string | null
}

/** Which conversation is this agent process running, and where. */
export async function probeAgentIdentity(
  kind: AgentKind,
  pid: number,
  opts: { claudeSessionsDir?: string } = {},
): Promise<AgentIdentity> {
  const cwd = await processCwd(pid)
  let found: { sessionId: string; cwd: string | null } | null = null
  if (kind === 'claude') {
    const dir = opts.claudeSessionsDir ?? join(homedir(), '.claude', 'sessions')
    try {
      found = claudeSessionFromFile(await readFile(join(dir, `${pid}.json`), 'utf8'), await procStartOf(pid))
    } catch {
      // older Claude Code without per-pid session files
    }
  } else {
    found = codexMainThread(await codexOpenRollouts(pid))
  }
  return {
    // Only the CURRENT identity counts: the id on the command line is where the
    // process started, and /clear or a fork may have moved it since.
    sessionId: found?.sessionId ?? null,
    // Claude files sessions under the directory it was launched in, so resume
    // must start there; Codex resumes from anywhere, the process cwd is truth
    cwd: kind === 'claude' ? (found?.cwd ?? cwd) : (cwd ?? found?.cwd ?? null),
  }
}
