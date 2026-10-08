import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { agentProcessForTty } from '../core/occupant.js'
import type { Backend } from '../core/types.js'
import { probeAgentIdentity } from './identity.js'
import type { SavedAgent } from './types.js'

const execFileP = promisify(execFile)

export function snapshotFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_SNAPSHOT_FILE ?? join(homedir(), '.termbus', 'snapshots.json')
}

/**
 * Identifies this run of iTerm2 (pid + start time; pids recycle across
 * reboots). null when iTerm2 is not running. Checked BEFORE any AppleScript:
 * `tell application "iTerm2"` would launch it, and a background autosaver
 * must never reopen a terminal the user just quit.
 */
export async function terminalInstance(): Promise<string | null> {
  try {
    // `ps` rather than pgrep: pgrep cannot see GUI apps from every context
    const { stdout } = await execFileP('ps', ['-axo', 'pid=,lstart=,comm='], { maxBuffer: 16 * 1024 * 1024 })
    return itermInstanceFromPs(stdout)
  } catch {
    return null
  }
}

/** `ps -axo pid=,lstart=,comm=` → "pid@start" of the iTerm2 app process. */
export function itermInstanceFromPs(psOutput: string): string | null {
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)
    if (m && /(^|\/)iTerm2$/.test(m[3]) && !m[3].includes('/XPCServices/')) {
      return `${m[1]}@${m[2].replace(/\s+/g, ' ')}`
    }
  }
  return null
}

/** Every agent pane right now, with the conversation it is running; null if
 *  the terminal is not running (it is never launched to find out). */
export async function captureAgents(backend: Backend): Promise<SavedAgent[] | null> {
  const panes = backend.listPanesIfRunning ? await backend.listPanesIfRunning() : await backend.listPanes()
  if (!panes) return null
  const out: SavedAgent[] = []
  for (const p of panes) {
    const proc = await agentProcessForTty(p.tty)
    if (!proc) continue
    const id = await probeAgentIdentity(proc.kind, proc.pid)
    out.push({
      paneId: p.id,
      windowIndex: p.windowIndex,
      tabIndex: p.tabIndex,
      paneIndex: p.paneIndex,
      title: p.title,
      kind: proc.kind,
      sessionId: id.sessionId,
      cwd: id.cwd,
      command: proc.command,
    })
  }
  return out
}

/** `ps -axo pid=,tty=,command=` → interactive claude/codex processes (on a tty). */
export function agentProcessesFromPs(psOutput: string): Array<{ pid: number; kind: 'claude' | 'codex' }> {
  const out: Array<{ pid: number; kind: 'claude' | 'codex' }> = []
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)/)
    if (!m || m[2] === '??' || m[2] === '-') continue
    const base = m[3].split('/').pop()
    if (base === 'claude' || base === 'codex') out.push({ pid: Number(m[1]), kind: base })
  }
  return out
}

export interface LiveAgents {
  ids: Set<string>
  /** running agents whose conversation could not be determined */
  uncertain: Array<{ kind: 'claude' | 'codex'; cwd: string | null }>
}

/**
 * Agents running anywhere on this Mac right now, found from the processes
 * themselves — not from iTerm2's pane list, which is empty while iTerm2 is
 * down even though its session server can keep agents alive. Fails closed:
 * throws if processes cannot be listed, and reports agents it could not
 * identify instead of leaving them out.
 */
export async function liveAgents(): Promise<LiveAgents> {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,tty=,command='], { maxBuffer: 16 * 1024 * 1024 })
  const live: LiveAgents = { ids: new Set(), uncertain: [] }
  for (const p of agentProcessesFromPs(stdout)) {
    const id = await probeAgentIdentity(p.kind, p.pid)
    if (id.sessionId) live.ids.add(id.sessionId)
    else live.uncertain.push({ kind: p.kind, cwd: id.cwd })
  }
  return live
}
