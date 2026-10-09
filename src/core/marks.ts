import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentKind, isNeverAgentCommand } from './agents.js'
import { TermbusError } from './errors.js'
import { withFileLock } from './filelock.js'
import type { Occupant } from './types.js'

/**
 * Manual marks: "the program in this pane is agent <kind>", for agents that
 * process detection can't see (launched through a wrapper…). Kept in
 * ~/.termbus/marks.json as {paneId: Mark}.
 *
 * A mark is bound to the PROCESS it was made on (pid + start time, so a
 * recycled pid doesn't count): when that program exits — or the pane is now
 * running something else — the mark stops applying, so a message meant for
 * the agent can never be typed into whatever replaced it. Marks carried over
 * by `restore` (new processes) fall back to the program's name.
 *
 * Marks made from HQ (`remote`) also stop applying when this Mac withdraws
 * its exec consent (`termbus bridge --no-exec`).
 */

export interface Mark {
  kind: string
  /** base name of the marked foreground program */
  command?: string
  pid?: number
  /** `ps -o lstart` of that pid, as rendered in UTC and in local time */
  start?: string[]
  /** made from HQ: applies only while this Mac allows exec */
  remote?: true
}

export type Marks = Record<string, Mark>

/** The foreground program a mark is made on / checked against. */
export interface ForegroundProc {
  pid: number
  command: string
  /** ps lstart renderings (UTC, local); null when unknown */
  start: string[] | null
}

export function marksFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_MARKS_FILE ?? join(homedir(), '.termbus', 'marks.json')
}

function cleanMark(v: unknown): Mark | null {
  // pre-binding files stored a bare kind: it can't be tied to a program, so it never applies
  if (typeof v === 'string') return { kind: v }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.kind !== 'string') return null
  return {
    kind: r.kind,
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
    ...(typeof r.pid === 'number' && Number.isInteger(r.pid) ? { pid: r.pid } : {}),
    ...(Array.isArray(r.start) && r.start.every((x) => typeof x === 'string') ? { start: r.start as string[] } : {}),
    ...(r.remote === true ? { remote: true as const } : {}),
  }
}

export function loadMarks(path = marksFile()): Marks {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Marks = {}
    for (const [k, v] of Object.entries(raw)) {
      const m = cleanMark(v)
      if (m) out[k] = m
    }
    return out
  } catch {
    return {}
  }
}

export function saveMarks(marks: Marks, path = marksFile()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(marks, null, 1))
  renameSync(tmp, path)
}

export function updateMarks(fn: (m: Marks) => Marks, path = marksFile()): Marks {
  return withFileLock(path, 'marks are being edited elsewhere — try again', () => {
    const next = fn(loadMarks(path))
    saveMarks(next, path)
    return next
  })
}

export const baseName = (command: string): string => {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return (first.split('/').pop() ?? first).replace(/^-/, '')
}

/**
 * Pure: mark the program `fg` in a pane as `kind`. Throws on an unknown kind,
 * on a pane with no program running, and on programs that are never agents
 * (shells, ssh, REPLs…) unless `force` (the user at the keyboard).
 */
export function markPane(
  marks: Marks,
  paneId: string,
  kind: string,
  fg: ForegroundProc | null,
  opts: { remote?: boolean; force?: boolean } = {},
): Marks {
  if (!isAgentKind(kind)) {
    throw new TermbusError(`unknown agent kind "${kind}" — built in: claude, codex, devin; others go in ~/.termbus/agents.json`)
  }
  if (!fg) throw new TermbusError('nothing is running in that pane — start the agent first, then mark it')
  if (isNeverAgentCommand(fg.command)) {
    const what = baseName(fg.command)
    if (opts.remote) throw new TermbusError(`refusing to mark "${what}" from HQ — it is a shell/interpreter/remote program, not an agent`)
    if (!opts.force) throw new TermbusError(`"${what}" is a shell/interpreter/remote program, not an agent — add --force if you really mean it`)
  }
  return {
    ...marks,
    [paneId]: {
      kind,
      command: baseName(fg.command),
      pid: fg.pid,
      ...(fg.start ? { start: fg.start } : {}),
      ...(opts.remote ? { remote: true as const } : {}),
    },
  }
}

export function unmarkPane(marks: Marks, paneId: string): Marks {
  const next = { ...marks }
  delete next[paneId]
  return next
}

/** Restore gave panes new ids and new processes: carry marks over, bound by program name only. */
export function remapMarks(marks: Marks, mapping: Map<string, string>): Marks {
  return Object.fromEntries(
    Object.entries(marks).map(([id, m]) => {
      const to = mapping.get(id)
      if (!to) return [id, m]
      const { pid: _pid, start: _start, ...byName } = m
      return [to, byName]
    }),
  )
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Does `mark` still describe the program in front of the pane? */
export function markApplies(mark: Mark | undefined, fg: ForegroundProc | null, ctx: { allowExec: boolean }): boolean {
  if (!mark || !fg || !isAgentKind(mark.kind)) return false
  if (mark.remote && !ctx.allowExec) return false
  if (mark.pid !== undefined) {
    if (fg.pid !== mark.pid) return false
    if (mark.start?.length) {
      if (!fg.start) return false
      return fg.start.some((a) => mark.start!.some((b) => squash(a) === squash(b)))
    }
    return true
  }
  // no pid recorded (carried over by restore): the same program by name
  return mark.command !== undefined && baseName(fg.command) === mark.command
}

/** A mark overrides process detection while it applies (see markApplies). */
export function applyMarkToOccupant(
  occ: Occupant,
  mark: Mark | undefined,
  fg: ForegroundProc | null,
  ctx: { allowExec: boolean },
): Occupant & { marked?: true } {
  if (occ.kind === 'shell' || occ.kind === 'unknown' || !markApplies(mark, fg, ctx)) return occ
  return { kind: mark!.kind, command: occ.command, marked: true }
}
