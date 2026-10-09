import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeMark, hqSenderLabel } from '../src/commands/bridge.js'
import { buildEnvelope, parseEnvelope } from '../src/core/envelope.js'
import { applyMark, applyMarkToOccupant, loadMarks, remapMarks, updateMarks } from '../src/core/marks.js'

let path: string
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'termbus-marks-')), 'marks.json')
})

describe('marks', () => {
  it('set / clear, only for kinds the registry knows', () => {
    const m = applyMark({}, 'P1', 'devin')
    expect(m).toEqual({ P1: 'devin' })
    expect(applyMark(m, 'P1', null)).toEqual({})
    expect(() => applyMark({}, 'P1', 'aider')).toThrow(/unknown agent kind "aider"/)
  })
  it('persists under a lock and tolerates junk in the file', () => {
    updateMarks((m) => applyMark(m, 'P1', 'codex'), path)
    updateMarks((m) => applyMark(m, 'P2', 'devin'), path)
    expect(loadMarks(path)).toEqual({ P1: 'codex', P2: 'devin' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ P1: 'codex', P2: 'devin' })
    expect(loadMarks('/nonexistent/marks.json')).toEqual({})
  })
  it('restore remaps marks to the reopened panes', () => {
    expect(remapMarks({ OLD: 'devin', KEEP: 'claude' }, new Map([['OLD', 'NEW']]))).toEqual({ NEW: 'devin', KEEP: 'claude' })
  })
  it('a mark wins over process detection — but only while a program runs', () => {
    expect(applyMarkToOccupant({ kind: 'command', command: 'node wrapper.js' }, 'devin')).toEqual({
      kind: 'devin',
      command: 'node wrapper.js',
      marked: true,
    })
    expect(applyMarkToOccupant({ kind: 'claude', command: 'claude' }, 'devin').kind).toBe('devin')
    // the agent exited: the pane is a shell again, so text can't run as a command
    expect(applyMarkToOccupant({ kind: 'shell', command: null }, 'devin')).toEqual({ kind: 'shell', command: null })
    expect(applyMarkToOccupant({ kind: 'unknown', command: null }, 'devin').kind).toBe('unknown')
    // a mark for a kind that no longer exists (removed from agents.json) is ignored
    expect(applyMarkToOccupant({ kind: 'command', command: 'x' }, 'gone')).toEqual({ kind: 'command', command: 'x' })
  })
})

describe('bridge `mark` action', () => {
  const act = (paneId: string, body: unknown, open = ['P1', 'P2']) =>
    executeMark({ paneId, payload: typeof body === 'string' ? body : JSON.stringify(body) }, open, path)

  it('marks and unmarks a pane', () => {
    expect(act('P1', { kind: 'devin' })).toEqual({ status: 'done', outcome: 'marked as devin' })
    expect(loadMarks(path)).toEqual({ P1: 'devin' })
    expect(act('P1', { kind: null })).toEqual({ status: 'done', outcome: 'unmarked' })
    expect(loadMarks(path)).toEqual({})
  })
  it('unmarking a pane that was never marked fails clearly', () => {
    expect(act('P2', { kind: null })).toEqual({ status: 'failed', outcome: 'this pane was detected automatically, not marked' })
  })
  it('refuses unknown kinds, closed panes and junk without touching the file', () => {
    expect(act('P1', { kind: 'aider' })).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/unknown agent kind/) })
    expect(act('P9', { kind: 'devin' })).toEqual({ status: 'failed', outcome: 'pane no longer exists' })
    expect(act('P1', 'nope').status).toBe('failed')
    expect(act('P1', { kind: 3 }).status).toBe('failed')
    expect(act('../x', { kind: 'devin' }).status).toBe('failed')
    expect(loadMarks(path)).toEqual({})
  })
})

describe('from=conductor', () => {
  it('HQ sends are from=hq unless the conductor wrote them', () => {
    expect(hqSenderLabel(undefined)).toBe('hq')
    expect(hqSenderLabel(null)).toBe('hq')
    expect(hqSenderLabel('user')).toBe('hq')
    expect(hqSenderLabel('conductor')).toBe('conductor')
    // fail-safe: an origin we don't know gets the lower-trust label
    expect(hqSenderLabel('something-new')).toBe('conductor')
  })
  it('the envelope carries the label', () => {
    const env = buildEnvelope({ label: hqSenderLabel('conductor'), kind: 'shell' }, 'abc123')
    expect(env).toBe('[termbus-msg v=1 from=conductor kind=shell id=abc123]')
    expect(parseEnvelope(env)).toEqual({ from: 'conductor', kind: 'shell', id: 'abc123' })
  })
})
