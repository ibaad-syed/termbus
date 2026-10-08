import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireLock } from '../src/commands/restore.js'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'termbus-lock-')), 'restore.lock')

describe('restore lock', () => {
  it('excludes a second holder while the first is alive', () => {
    const p = lockPath()
    const release = acquireLock(p)
    // a different live process (our parent) cannot take it
    expect(() => acquireLock(p, process.ppid)).toThrow(/another `termbus restore`/)
    release()
    acquireLock(p, process.ppid)()
  })

  it('reclaims a lock whose owner is dead', () => {
    const p = lockPath()
    writeFileSync(p, '999999') // no such pid
    const release = acquireLock(p)
    release()
  })

  it('only the owner releases', () => {
    const p = lockPath()
    const release = acquireLock(p)
    writeFileSync(p, String(process.ppid)) // someone else holds it now
    release() // ours is gone: must not delete theirs
    expect(readFileSync(p, 'utf8')).toBe(String(process.ppid))
  })
})
