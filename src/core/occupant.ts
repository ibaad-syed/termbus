import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Occupant } from './types.js'

const execFileP = promisify(execFile)

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'nu'])

interface PsRow {
  pid: number
  stat: string
  command: string
}

function parsePs(psOutput: string): PsRow[] {
  return psOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const m = line.match(/^(\d+)\s+\d+\s+(\S+)\s+(.*)$/) ?? line.match(/^(\d+)\s+(\S+)\s+(.*)$/)
      return m ? [{ pid: Number(m[1]), stat: m[2], command: m[3] }] : []
    })
}

function commandBase(command: string): string {
  const first = command.split(/\s+/)[0] ?? ''
  const base = first.split('/').pop() ?? first
  return base.replace(/^-/, '') // login shells appear as "-zsh"
}

export function classifyPs(psOutput: string): Occupant {
  const rows = parsePs(psOutput)
  const fg = rows.filter((r) => r.stat.includes('+') && !r.command.startsWith('login '))
  if (fg.length === 0) return { kind: 'unknown', command: null }
  const nonShell = fg.filter((r) => !SHELLS.has(commandBase(r.command)))
  if (nonShell.length === 0) return { kind: 'shell', command: null }
  // The direct TUI process (claude/codex/vim) has the lowest pid among its
  // foreground descendants (mcp servers, node children, etc.)
  const primary = nonShell.reduce((a, b) => (a.pid < b.pid ? a : b))
  const base = commandBase(primary.command)
  if (base === 'claude') return { kind: 'claude', command: primary.command }
  if (base === 'codex') return { kind: 'codex', command: primary.command }
  return { kind: 'command', command: primary.command }
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
