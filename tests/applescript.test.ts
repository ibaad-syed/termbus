import { describe, expect, it } from 'vitest'
import { parseListOutput, selfSessionIdFromEnv } from '../src/backends/applescript.js'

const FS = String.fromCharCode(31)
const RS = String.fromCharCode(30)

describe('parseListOutput', () => {
  it('parses records into panes with labels and self-marking', () => {
    const raw =
      ['1', '1', '1', 'AAA-UUID', '/dev/ttys008', 'reviewer claude'].join(FS) + RS +
      ['1', '1', '2', 'BBB-UUID', '/dev/ttys009', 'Default (-zsh)'].join(FS) + RS
    const panes = parseListOutput(raw, 'BBB-UUID')
    expect(panes).toHaveLength(2)
    expect(panes[0]).toMatchObject({
      id: 'AAA-UUID',
      label: 'w1.t1.p1',
      title: 'reviewer claude',
      tty: '/dev/ttys008',
      isSelf: false,
    })
    expect(panes[1].isSelf).toBe(true)
    expect(panes[1].label).toBe('w1.t1.p2')
  })
  it('returns [] for empty output', () => {
    expect(parseListOutput('', null)).toEqual([])
  })
  it('skips truncated garbage records with fewer than 6 fields', () => {
    const raw =
      ['1', '1', '1', 'OK-UUID', '/dev/ttys001', 'good pane'].join(FS) + RS +
      ['1', '1', 'garbage'].join(FS) + RS
    const panes = parseListOutput(raw, null)
    expect(panes).toHaveLength(1)
    expect(panes[0].id).toBe('OK-UUID')
  })
})

describe('selfSessionIdFromEnv', () => {
  it('strips the wNtNpN: prefix from ITERM_SESSION_ID', () => {
    expect(selfSessionIdFromEnv({ ITERM_SESSION_ID: 'w0t0p0:DAEADA41-BC8A' })).toBe('DAEADA41-BC8A')
  })
  it('returns null when unset', () => {
    expect(selfSessionIdFromEnv({})).toBeNull()
  })
})
