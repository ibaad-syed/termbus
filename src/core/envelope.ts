import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { agentForCommand } from './agents.js'
import type { AgentKind } from './types.js'

const execFileP = promisify(execFile)

/**
 * Sender attribution for agent-to-agent messages. One compact, versioned,
 * regex-parseable line prepended to prompts delivered to agent panes:
 *
 *   [termbus-msg v=1 from=w1.t1.p2 kind=claude id=x7k2p9] <message>
 *
 * Design notes (from codex review):
 * - kind is the OBSERVED process ancestry of the termbus invocation, never an
 *   authority claim: an agent kind from the registry — claude/codex/devin/… —
 *   (an agent ran termbus), shell (a person's shell), unknown. It is advisory and spoofable by anything that can type
 *   into a pane — real signed identity belongs to the HQ layer.
 * - No title field: titles are unstable, unescapable, and spoof bait.
 * - from is the sender's pane label (resolvable as a reply target); external
 *   when termbus runs outside any iTerm2 pane. The bridge uses two reserved
 *   labels: hq (the user, via the HQ app) and conductor (the user's HQ
 *   Conductor, an AI coordinator acting for the user — not the user).
 */

export type SenderKind = AgentKind | 'shell' | 'unknown'

export interface Sender {
  label: string // pane label, or "external"
  kind: SenderKind
}

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', 'csh', 'ksh', 'nu', 'login'])

export interface PsRow {
  pid: number
  ppid: number
  comm: string
}

export function parsePsTable(out: string): PsRow[] {
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .flatMap((m) => (m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] }] : []))
}

/**
 * Walk our own ancestry: if an agent process spawned this termbus invocation
 * (claude's Bash tool, codex's shell), that agent is the sender. A shell with
 * no agent above it means a person typed the command.
 */
export function classifyAncestry(rows: PsRow[], startPid: number, maxDepth = 25): SenderKind {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  let pid = startPid
  let sawShell = false
  for (let i = 0; i < maxDepth; i++) {
    const row = byPid.get(pid)
    if (!row) break
    const base = (row.comm.split(/\s+/)[0]?.split('/').pop() ?? '').replace(/^-/, '')
    // helper processes count too: a Devin tool call runs under `devin acp`
    const agent = agentForCommand(row.comm, { respectExclude: false })
    if (agent) return agent.id
    if (SHELL_NAMES.has(base)) sawShell = true
    if (row.ppid <= 1 || row.ppid === pid) break
    pid = row.ppid
  }
  return sawShell ? 'shell' : 'unknown'
}

export async function detectSenderKind(): Promise<SenderKind> {
  try {
    const { stdout } = await execFileP('ps', ['-ax', '-o', 'pid=,ppid=,comm='])
    return classifyAncestry(parsePsTable(stdout), process.pid)
  } catch {
    return 'unknown'
  }
}

export function buildEnvelope(sender: Sender, id: string): string {
  return `[termbus-msg v=1 from=${sender.label} kind=${sender.kind} id=${id}]`
}

export function envelopeId(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Parse an envelope line back out (for HQ ingestion / tests). */
export function parseEnvelope(line: string): { from: string; kind: string; id: string } | null {
  const m = line.match(/^\[termbus-msg v=1 from=(\S+) kind=(\S+) id=(\S+)\]/)
  return m ? { from: m[1], kind: m[2], id: m[3] } : null
}
