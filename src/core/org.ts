import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TermbusError } from './errors.js'
import { resolveTarget } from './resolve.js'
import type { Pane } from './types.js'

/**
 * Departments: named groups of agent panes ("api", "frontend", "media"). Kept
 * on this Mac in ~/.termbus/org.json so they work in plain termbus without
 * HQ; the bridge mirrors them to HQ and applies HQ's edits ('org' actions).
 * Members are pane ids — restore remaps them when panes come back with new
 * ids. A pane belongs to at most one department, like a person in a company.
 */

export interface Department {
  name: string
  members: string[] // pane ids
  createdAt: number
}

export interface Org {
  v: 1
  departments: Department[]
}

export function orgFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_ORG_FILE ?? join(homedir(), '.termbus', 'org.json')
}

export function emptyOrg(): Org {
  return { v: 1, departments: [] }
}

export function loadOrg(path = orgFile()): Org {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Org
    if (o.v === 1 && Array.isArray(o.departments)) {
      // tolerate hand edits: keep only well-formed departments
      return {
        v: 1,
        departments: o.departments
          .filter((d) => d && typeof d.name === 'string' && Array.isArray(d.members))
          .map((d) => ({ name: d.name, members: d.members.filter((m) => typeof m === 'string'), createdAt: Number(d.createdAt) || 0 })),
      }
    }
  } catch {
    // missing or corrupt
  }
  return emptyOrg()
}

/**
 * Read-modify-write under a lock, so the CLI, the bridge (HQ edits) and
 * restore can't overwrite each other's changes. The lock is a directory
 * (atomic mkdir); a stale one (crashed holder) is broken after 10s.
 */
export function updateOrg(fn: (org: Org) => Org, path = orgFile()): Org {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true })
      } catch {
        // released meanwhile
      }
      if (Date.now() > deadline) throw new TermbusError('departments are being edited elsewhere — try again')
      const until = Date.now() + 25
      while (Date.now() < until) {
        // brief spin; edits are tiny
      }
    }
  }
  try {
    const next = fn(loadOrg(path))
    saveOrg(next, path)
    return next
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

export function saveOrg(org: Org, path = orgFile()): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(org, null, 1))
  renameSync(tmp, path)
}

const NAME = /^[a-z0-9][a-z0-9 _-]{0,39}$/i

export function validDeptName(name: string): boolean {
  return NAME.test(name.trim())
}

function find(org: Org, name: string): Department | undefined {
  const n = name.trim().toLowerCase()
  return org.departments.find((d) => d.name.toLowerCase() === n)
}

export type OrgOp =
  | { op: 'create'; department: string }
  | { op: 'delete'; department: string }
  | { op: 'rename'; department: string; newName: string }
  | { op: 'add'; department: string; paneIds: string[] }
  | { op: 'remove'; department: string; paneIds: string[] }

/** Pure: returns the new org or throws a TermbusError with a clear reason. */
export function applyOrgOp(org: Org, o: OrgOp, now = Date.now()): Org {
  const depts = org.departments.map((d) => ({ ...d, members: [...d.members] }))
  const next: Org = { v: 1, departments: depts }
  const name = o.department?.trim() ?? ''
  const dept = find(next, name)
  switch (o.op) {
    case 'create':
      if (!validDeptName(name)) throw new TermbusError(`invalid department name "${name}" (letters, digits, space, - or _, up to 40)`)
      if (dept) throw new TermbusError(`department "${dept.name}" already exists`)
      depts.push({ name, members: [], createdAt: now })
      return next
    case 'delete':
      if (!dept) throw new TermbusError(`no department "${name}"`)
      next.departments = depts.filter((d) => d !== dept)
      return next
    case 'rename': {
      if (!dept) throw new TermbusError(`no department "${name}"`)
      const to = o.newName.trim()
      if (!validDeptName(to)) throw new TermbusError(`invalid department name "${to}"`)
      const clash = find(next, to)
      if (clash && clash !== dept) throw new TermbusError(`department "${clash.name}" already exists`)
      dept.name = to
      return next
    }
    case 'add':
      if (!dept) throw new TermbusError(`no department "${name}" — create it first`)
      for (const id of o.paneIds) {
        for (const d of depts) d.members = d.members.filter((m) => m !== id) // one department per pane
        dept.members.push(id)
      }
      return next
    case 'remove':
      if (!dept) throw new TermbusError(`no department "${name}"`)
      dept.members = dept.members.filter((m) => !o.paneIds.includes(m))
      return next
  }
}

export function departmentOf(org: Org, paneId: string): Department | undefined {
  return org.departments.find((d) => d.members.includes(paneId))
}

/** Restore gave panes new ids: carry memberships over. */
export function remapMembers(org: Org, mapping: Map<string, string>): Org {
  return {
    v: 1,
    departments: org.departments.map((d) => ({ ...d, members: d.members.map((m) => mapping.get(m) ?? m) })),
  }
}

/**
 * A multi-target spec: "@all" (every agent pane but yourself), "@<department>",
 * or a comma list of ordinary targets / @groups. Returns the panes (deduped,
 * self excluded) and the label to show recipients ("@api", "@all", or null for
 * a plain list). `isAgent` filters @all to agent panes.
 */
export function resolveGroupTargets(
  panes: Pane[],
  org: Org,
  spec: string,
  isAgent: (p: Pane) => boolean,
): { panes: Pane[]; group: string | null; missing: string[] } {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean)
  const out = new Map<string, Pane>()
  const missing: string[] = []
  for (const part of parts) {
    if (part.toLowerCase() === '@all') {
      for (const p of panes) if (!p.isSelf && isAgent(p)) out.set(p.id, p)
    } else if (part.startsWith('@')) {
      const dept = find(org, part.slice(1))
      if (!dept) throw new TermbusError(`no department "${part.slice(1)}" — see \`termbus dept list\``)
      for (const id of dept.members) {
        const p = panes.find((x) => x.id === id)
        if (!p) missing.push(id)
        else if (!p.isSelf) out.set(p.id, p)
      }
    } else {
      const p = resolveTarget(panes, part)
      if (!p.isSelf) out.set(p.id, p)
    }
  }
  return { panes: [...out.values()], group: parts.length === 1 && parts[0].startsWith('@') ? parts[0] : null, missing }
}

/**
 * "@dept" / "@all" are always groups. A comma list is a group only if the
 * whole string is not itself a target (a pane titled "foo, bar" still works).
 */
export function isGroupSpec(target: string, panes?: Pane[]): boolean {
  const t = target.trim()
  if (t.startsWith('@')) return true
  if (!t.includes(',')) return false
  if (!panes) return true
  try {
    resolveTarget(panes, t)
    return false
  } catch {
    return true
  }
}
