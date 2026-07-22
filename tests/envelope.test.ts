import { describe, expect, it } from 'vitest'
import { buildEnvelope, classifyAncestry, parseEnvelope, parsePsTable } from '../src/core/envelope.js'

const table = (rows: Array<[number, number, string]>) =>
  rows.map(([pid, ppid, comm]) => ({ pid, ppid, comm }))

describe('classifyAncestry', () => {
  it('finds an agent ancestor (claude Bash tool → termbus)', () => {
    const rows = table([
      [100, 1, '/sbin/launchd'],
      [200, 100, '-zsh'],
      [300, 200, 'claude'],
      [400, 300, '/bin/zsh'],
      [500, 400, 'node'], // termbus itself
    ])
    expect(classifyAncestry(rows, 500)).toBe('claude')
  })

  it('a plain shell ancestry means a person typed it', () => {
    const rows = table([
      [100, 1, 'login'],
      [200, 100, '-zsh'],
      [500, 200, 'node'],
    ])
    expect(classifyAncestry(rows, 500)).toBe('shell')
  })

  it('unknown when nothing recognizable is above us', () => {
    const rows = table([[500, 1, 'node']])
    expect(classifyAncestry(rows, 500)).toBe('unknown')
  })

  it('survives ppid cycles and missing rows', () => {
    const rows = table([[500, 500, 'node']])
    expect(classifyAncestry(rows, 500)).toBe('unknown')
    expect(classifyAncestry(rows, 999)).toBe('unknown')
  })
})

describe('envelope format', () => {
  it('round-trips through parseEnvelope', () => {
    const env = buildEnvelope({ label: 'w1.t2.p3', kind: 'codex' }, 'ab12cd')
    expect(env).toBe('[termbus-msg v=1 from=w1.t2.p3 kind=codex id=ab12cd]')
    expect(parseEnvelope(`${env} hello there`)).toEqual({ from: 'w1.t2.p3', kind: 'codex', id: 'ab12cd' })
  })

  it('rejects non-envelope lines', () => {
    expect(parseEnvelope('hello [termbus-msg v=1 from=x kind=y id=z]')).toBeNull()
  })
})

describe('parsePsTable', () => {
  it('parses ps -o pid=,ppid=,comm= output', () => {
    const rows = parsePsTable(' 100     1 /sbin/launchd\n 200   100 -zsh\n')
    expect(rows).toEqual([
      { pid: 100, ppid: 1, comm: '/sbin/launchd' },
      { pid: 200, ppid: 100, comm: '-zsh' },
    ])
  })
})
