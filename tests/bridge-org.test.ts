import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeOrg } from '../src/commands/bridge.js'
import { loadOrg } from '../src/core/org.js'

beforeEach(() => {
  process.env.TERMBUS_ORG_FILE = join(mkdtempSync(join(tmpdir(), 'termbus-org-')), 'org.json')
})
const act = (o: unknown) => executeOrg({ payload: typeof o === 'string' ? o : JSON.stringify(o) })

describe('executeOrg (HQ edits departments on this Mac)', () => {
  it('applies ops to ~/.termbus/org.json and returns the new org', () => {
    expect(act({ op: 'create', department: 'api' }).status).toBe('done')
    const r = act({ op: 'add', department: 'api', paneIds: ['P1'] })
    expect(JSON.parse(r.outcome!).departments[0].members).toEqual(['P1'])
    expect(loadOrg().departments[0]).toMatchObject({ name: 'api', members: ['P1'] })
  })
  it('refuses junk without touching the file', () => {
    expect(act('nope').status).toBe('failed')
    expect(act({ op: 'drop-tables' }).status).toBe('failed')
    expect(act({ op: 'add', department: 'api', paneIds: 'P1' }).status).toBe('failed')
    expect(act({ op: 'add', department: 'missing', paneIds: ['P1'] })).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/create it first/) })
    expect(loadOrg().departments).toEqual([])
  })
})

describe('org payload limits', () => {
  it('rejects oversized or malformed paneIds', () => {
    act({ op: 'create', department: 'api' })
    expect(act({ op: 'add', department: 'api', paneIds: Array.from({ length: 65 }, (_, i) => `P${i}`) }).status).toBe('failed')
    expect(act({ op: 'add', department: 'api', paneIds: ['x'.repeat(201)] }).status).toBe('failed')
    expect(act({ op: 'add', department: 'api', paneIds: ['../../etc'] }).status).toBe('failed')
  })
})
