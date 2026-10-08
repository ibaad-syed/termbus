import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Occupant } from './types.js'

const execFileP = promisify(execFile)

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'nu'])

interface PsRow {
  pid: number
  ppid: number
  stat: string
  command: string
}

function parsePs(psOutput: string): PsRow[] {
  return psOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const withPpid = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (withPpid) {
        return [
          { pid: Number(withPpid[1]), ppid: Number(withPpid[2]), stat: withPpid[3], command: withPpid[4] },
        ]
      }
      const noPpid = line.match(/^(\d+)\s+(\S+)\s+(.*)$/)
      return noPpid
        ? [{ pid: Number(noPpid[1]), ppid: -1, stat: noPpid[2], command: noPpid[3] }]
        : []
    })
}

function commandBase(command: string): string {
  const first = command.split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? first
  return base.replace(/^-/, '') // login shells appear as "-zsh"
}

/** The pane's foreground program: the non-shell process launched directly
 *  from the pane's shell. null when only a shell (or nothing) is in front. */
export function foregroundProcess(psOutput: string): { pid: number; command: string } | null {
  const rows = parsePs(psOutput)
  const fg = rows.filter((r) => r.stat.includes('+') && !r.command.startsWith('login '))
  const nonShell = fg.filter((r) => !SHELLS.has(commandBase(r.command)))
  if (nonShell.length === 0) return null
  // The TUI (claude/codex/vim) is launched directly from the pane's shell, so
  // its ppid is a shell pid; its own children (mcp servers, node helpers) are
  // parented by the TUI instead. Prefer shell-parented rows to stay correct
  // under pid wraparound, where a child can hold a lower pid than the TUI.
  const shellPids = new Set(rows.filter((r) => SHELLS.has(commandBase(r.command))).map((r) => r.pid))
  const shellParented = nonShell.filter((r) => shellPids.has(r.ppid))
  const candidates = shellParented.length > 0 ? shellParented : nonShell
  const primary = candidates.reduce((a, b) => (a.pid < b.pid ? a : b))
  return { pid: primary.pid, command: primary.command }
}

export function classifyPs(psOutput: string): Occupant {
  const rows = parsePs(psOutput)
  const fg = rows.filter((r) => r.stat.includes('+') && !r.command.startsWith('login '))
  if (fg.length === 0) return { kind: 'unknown', command: null }
  const primary = foregroundProcess(psOutput)
  if (!primary) return { kind: 'shell', command: null }
  const base = commandBase(primary.command)
  if (base === 'claude') return { kind: 'claude', command: primary.command }
  if (base === 'codex') return { kind: 'codex', command: primary.command }
  return { kind: 'command', command: primary.command }
}

/** The agent (claude/codex) in front of a pane, with its pid; null otherwise. */
export async function agentProcessForTty(
  tty: string,
): Promise<{ kind: 'claude' | 'codex'; pid: number; command: string } | null> {
  const ttyName = tty.replace(/^\/dev\//, '')
  let stdout: string
  try {
    ;({ stdout } = await execFileP('ps', ['-t', ttyName, '-o', 'pid=,ppid=,stat=,command=']))
  } catch {
    return null
  }
  const occ = classifyPs(stdout)
  const fg = foregroundProcess(stdout)
  if ((occ.kind !== 'claude' && occ.kind !== 'codex') || !fg) return null
  return { kind: occ.kind, pid: fg.pid, command: fg.command }
}

export async function occupantForTty(tty: string): Promise<Occupant> {
  const ttyName = tty.replace(/^\/dev\//, '')
  try {
    const { stdout } = await execFileP('ps', ['-t', ttyName, '-o', 'pid=,ppid=,stat=,command='])
    return classifyPs(stdout)
  } catch {
    return { kind: 'unknown', command: null } // ps exits 1 when tty has no processes
  }
}
