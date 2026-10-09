import { describe, expect, it } from 'vitest'
import { applyOrgOp, departmentOf, emptyOrg, isGroupSpec, remapMembers, resolveGroupTargets, type Org } from '../src/core/org.js'
import type { Pane } from '../src/core/types.js'

const pane = (id: string, n: number, over: Partial<Pane> = {}): Pane => ({
  id,
  label: `w1.t${n}.p1`,
  title: `agent ${id}`,
  tty: `/dev/ttys00${n}`,
  isSelf: false,
  windowIndex: 1,
  tabIndex: n,
  paneIndex: 1,
  ...over,
})

describe('applyOrgOp', () => {
  it('create / add / move between departments / remove / rename / delete', () => {
    let o: Org = emptyOrg()
    o = applyOrgOp(o, { op: 'create', department: 'api' }, 1)
    o = applyOrgOp(o, { op: 'create', department: 'Frontend' }, 2)
    o = applyOrgOp(o, { op: 'add', department: 'API', paneIds: ['A', 'B'] })
    expect(departmentOf(o, 'A')?.name).toBe('api')
    o = applyOrgOp(o, { op: 'add', department: 'frontend', paneIds: ['B'] }) // one dept per pane
    expect(o.departments.map((d) => [d.name, d.members])).toEqual([
      ['api', ['A']],
      ['Frontend', ['B']],
    ])
    o = applyOrgOp(o, { op: 'remove', department: 'api', paneIds: ['A'] })
    o = applyOrgOp(o, { op: 'rename', department: 'frontend', newName: 'web' })
    expect(o.departments.map((d) => d.name)).toEqual(['api', 'web'])
    o = applyOrgOp(o, { op: 'delete', department: 'api' })
    expect(o.departments.map((d) => d.name)).toEqual(['web'])
  })
  it('rejects duplicates, bad names, unknown departments', () => {
    const o = applyOrgOp(emptyOrg(), { op: 'create', department: 'api' })
    expect(() => applyOrgOp(o, { op: 'create', department: 'API' })).toThrow(/already exists/)
    expect(() => applyOrgOp(o, { op: 'create', department: '@evil' })).toThrow(/invalid/)
    expect(() => applyOrgOp(o, { op: 'create', department: 'x'.repeat(41) })).toThrow(/invalid/)
    expect(() => applyOrgOp(o, { op: 'add', department: 'nope', paneIds: ['A'] })).toThrow(/create it first/)
  })
  it('is pure (input untouched)', () => {
    const o = applyOrgOp(emptyOrg(), { op: 'create', department: 'api' })
    applyOrgOp(o, { op: 'add', department: 'api', paneIds: ['A'] })
    expect(o.departments[0].members).toEqual([])
  })
})

describe('remapMembers (restore gave panes new ids)', () => {
  it('carries membership over', () => {
    let o = applyOrgOp(emptyOrg(), { op: 'create', department: 'api' })
    o = applyOrgOp(o, { op: 'add', department: 'api', paneIds: ['OLD1', 'KEEP'] })
    expect(remapMembers(o, new Map([['OLD1', 'NEW1']])).departments[0].members).toEqual(['NEW1', 'KEEP'])
  })
})

describe('resolveGroupTargets', () => {
  const panes = [pane('A', 1), pane('B', 2), pane('S', 3, { isSelf: true }), pane('SH', 4)]
  const isAgent = (p: Pane) => p.id !== 'SH'
  let org = applyOrgOp(emptyOrg(), { op: 'create', department: 'api' })
  org = applyOrgOp(org, { op: 'add', department: 'api', paneIds: ['A', 'S', 'GONE'] })

  it('@all = every agent pane except self', () => {
    expect(resolveGroupTargets(panes, org, '@all', isAgent).panes.map((p) => p.id)).toEqual(['A', 'B'])
  })
  it('@dept = live members except self; reports members whose pane is gone', () => {
    const r = resolveGroupTargets(panes, org, '@API', isAgent)
    expect(r.panes.map((p) => p.id)).toEqual(['A'])
    expect(r.group).toBe('@API')
    expect(r.missing).toEqual(['GONE'])
  })
  it('comma lists mix targets and groups, deduped', () => {
    const r = resolveGroupTargets(panes, org, 'w1.t2.p1, @api, A', isAgent)
    expect(r.panes.map((p) => p.id)).toEqual(['B', 'A'])
    expect(r.group).toBeNull()
  })
  it('unknown department → clear error', () => {
    expect(() => resolveGroupTargets(panes, org, '@ops', isAgent)).toThrow(/no department "ops"/)
  })
  it('isGroupSpec', () => {
    expect(isGroupSpec('@api')).toBe(true)
    expect(isGroupSpec('a,b')).toBe(true)
    expect(isGroupSpec('w1.t1.p1')).toBe(false)
  })
})
