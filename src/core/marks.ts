import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentKind } from './agents.js'
import { TermbusError } from './errors.js'
import { withFileLock } from './filelock.js'
import type { Occupant } from './types.js'

/**
 * Manual marks: "the program in this pane is agent <kind>", for agents that
 * process detection can't see (launched through a wrapper, an interpreter,
 * ssh…). Kept in ~/.termbus/marks.json as {paneId: kind}; restore remaps pane
 * ids like department memberships.
 *
 * A mark only applies while SOMETHING runs in the pane: once the program
 * exits and the pane is back at its shell prompt, the pane is a shell again —
 * otherwise a message meant for the agent would run as a shell command.
 */

export type Marks = Record<string, string>

export function marksFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_MARKS_FILE ?? join(homedir(), '.termbus', 'marks.json')
}

export function loadMarks(path = marksFile()): Marks {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    // tolerate hand edits: keep only string → string entries
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof k === 'string' && typeof v === 'string')) as Marks
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

/** Pure: set (kind) or clear (null) one pane's mark. Throws on an unknown kind. */
export function applyMark(marks: Marks, paneId: string, kind: string | null): Marks {
  const next = { ...marks }
  if (kind === null) {
    delete next[paneId]
    return next
  }
  if (!isAgentKind(kind)) {
    throw new TermbusError(`unknown agent kind "${kind}" — built in: claude, codex, devin; others go in ~/.termbus/agents.json`)
  }
  next[paneId] = kind
  return next
}

/** Restore gave panes new ids: carry marks over. */
export function remapMarks(marks: Marks, mapping: Map<string, string>): Marks {
  return Object.fromEntries(Object.entries(marks).map(([id, kind]) => [mapping.get(id) ?? id, kind]))
}

/** A mark overrides process detection, but only while a program is running. */
export function applyMarkToOccupant(occ: Occupant, mark: string | undefined): Occupant & { marked?: true } {
  if (!mark || occ.kind === 'shell' || occ.kind === 'unknown' || !isAgentKind(mark)) return occ
  return { kind: mark, command: occ.command, marked: true }
}
