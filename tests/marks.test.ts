import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { conductorRefusal, executeMark, hqSenderLabel, MARK_NEEDS_EXEC } from '../src/commands/bridge.js'
import { buildEnvelope, parseEnvelope } from '../src/core/envelope.js'
import {
  applyMarkToOccupant,
  loadMarks,
  markApplies,
  markPane,
  remapMarks,
  unmarkPane,
  updateMarks,
  type ForegroundProc,
} from '../src/core/marks.js'

let path: string
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'termbus-marks-')), 'marks.json')
})

const START = ['Thu Oct  8 20:47:41 2026', 'Thu Oct  8 22:47:41 2026']
const WRAPPER: ForegroundProc = { pid: 4242, command: '/opt/bin/devin-wrapper --fast', start: START }
const ok = { allowExec: true }

describe('marks are bound to the marked process', () => {
  it('records kind, program name, pid and start time', () => {
    expect(markPane({}, 'P1', 'devin', WRAPPER)).toEqual({ P1: { kind: 'devin', command: 'devin-wrapper', pid: 4242, start: START } })
    expect(unmarkPane({ P1: { kind: 'devin' } }, 'P1')).toEqual({})
  })
  it('applies only while the same pid with the same start time is in front', () => {
    const m = markPane({}, 'P1', 'devin', WRAPPER).P1
    expect(markApplies(m, WRAPPER, ok)).toBe(true)
    // ps renders start times with variable spacing; either rendering matches
    expect(markApplies(m, { ...WRAPPER, start: ['Thu Oct 8 22:47:41 2026'] }, ok)).toBe(true)
    // the program exited and the pane runs something else now
    expect(markApplies(m, { pid: 5000, command: 'ssh prod', start: ['Fri Oct  9 01:00:00 2026'] }, ok)).toBe(false)
    // same pid, recycled by a different program
    expect(markApplies(m, { ...WRAPPER, start: ['Fri Oct  9 01:00:00 2026'] }, ok)).toBe(false)
    expect(markApplies(m, { ...WRAPPER, start: null }, ok)).toBe(false)
    expect(markApplies(m, null, ok)).toBe(false)
  })
  it('without pid info (carried over by restore) it falls back to the program name', () => {
    expect(markApplies({ kind: 'devin', command: 'devin-wrapper' }, { pid: 1, command: '/usr/local/bin/devin-wrapper x', start: null }, ok)).toBe(true)
    expect(markApplies({ kind: 'devin', command: 'devin-wrapper' }, { pid: 1, command: 'ssh prod', start: null }, ok)).toBe(false)
    // a bare-kind entry (older file) can't be tied to a program: never applies
    expect(markApplies({ kind: 'devin' }, WRAPPER, ok)).toBe(false)
  })
  it('a remote mark applies only while this Mac still allows exec', () => {
    const m = markPane({}, 'P1', 'devin', WRAPPER, { remote: true }).P1
    expect(m.remote).toBe(true)
    expect(markApplies(m, WRAPPER, { allowExec: true })).toBe(true)
    expect(markApplies(m, WRAPPER, { allowExec: false })).toBe(false)
    // local marks don't depend on exec consent
    expect(markApplies(markPane({}, 'P1', 'devin', WRAPPER).P1, WRAPPER, { allowExec: false })).toBe(true)
  })
  it('restore remaps marks to the new panes, bound by name (new processes)', () => {
    const marks = { OLD: { kind: 'devin', command: 'devin-wrapper', pid: 4242, start: START }, KEEP: { kind: 'claude', command: 'x', pid: 1 } }
    expect(remapMarks(marks, new Map([['OLD', 'NEW']]))).toEqual({ NEW: { kind: 'devin', command: 'devin-wrapper' }, KEEP: marks.KEEP })
  })
  it('occupant: the mark wins while it applies; a shell pane is never an agent', () => {
    const m = markPane({}, 'P1', 'devin', WRAPPER).P1
    expect(applyMarkToOccupant({ kind: 'command', command: WRAPPER.command }, m, WRAPPER, ok)).toEqual({
      kind: 'devin',
      command: WRAPPER.command,
      marked: true,
    })
    expect(applyMarkToOccupant({ kind: 'shell', command: null }, m, null, ok)).toEqual({ kind: 'shell', command: null })
    const ssh = { pid: 5000, command: 'ssh prod', start: ['Fri Oct  9 01:00:00 2026'] }
    expect(applyMarkToOccupant({ kind: 'command', command: 'ssh prod' }, m, ssh, ok)).toEqual({ kind: 'command', command: 'ssh prod' })
    // a kind that no longer exists (removed from agents.json) is ignored
    expect(applyMarkToOccupant({ kind: 'command', command: 'x' }, { ...m, kind: 'gone' }, WRAPPER, ok).kind).toBe('command')
  })
})

describe('what can be marked', () => {
  it('only registry kinds, only a running program', () => {
    expect(() => markPane({}, 'P1', 'aider', WRAPPER)).toThrow(/unknown agent kind "aider"/)
    expect(() => markPane({}, 'P1', 'devin', null)).toThrow(/nothing is running/)
  })
  it('shells, ssh, REPLs, editors: local needs --force, remote never', () => {
    for (const command of ['ssh prod', '/usr/bin/psql db', 'python3', 'python3.12', 'vim x', '-zsh', 'sudo -s', 'docker exec -it c sh', 'tmux a']) {
      const fg = { pid: 7, command, start: null }
      expect(() => markPane({}, 'P1', 'devin', fg)).toThrow(/--force/)
      expect(markPane({}, 'P1', 'devin', fg, { force: true }).P1.kind).toBe('devin')
      expect(() => markPane({}, 'P1', 'devin', fg, { remote: true, force: true })).toThrow(/refusing to mark .* from HQ/)
    }
  })
  it('persists under a lock; tolerates junk and older bare-kind entries', () => {
    updateMarks((m) => markPane(m, 'P1', 'codex', WRAPPER), path)
    expect(loadMarks(path)).toEqual({ P1: { kind: 'codex', command: 'devin-wrapper', pid: 4242, start: START } })
    expect(JSON.parse(readFileSync(path, 'utf8')).P1.pid).toBe(4242)
    writeFileSync(path, JSON.stringify({ A: 'devin', B: 3, C: { kind: 'claude', pid: 'x', remote: 'yes' } }))
    expect(loadMarks(path)).toEqual({ A: { kind: 'devin' }, C: { kind: 'claude' } })
    expect(loadMarks('/nonexistent/marks.json')).toEqual({})
  })
})

describe('bridge `mark` action', () => {
  const act = (paneId: string, body: unknown, fg: ForegroundProc | null | undefined = WRAPPER, extra: { origin?: string; allowExec?: boolean } = {}) =>
    executeMark(
      { paneId, payload: typeof body === 'string' ? body : JSON.stringify(body), origin: extra.origin },
      fg,
      { allowExec: extra.allowExec ?? true },
      path,
    )

  it('marks (remote, bound to the process) and unmarks a pane', () => {
    expect(act('P1', { kind: 'devin' })).toEqual({ status: 'done', outcome: 'marked as devin' })
    expect(loadMarks(path)).toEqual({ P1: { kind: 'devin', command: 'devin-wrapper', pid: 4242, start: START, remote: true } })
    expect(act('P1', { kind: null })).toEqual({ status: 'done', outcome: 'unmarked' })
    expect(loadMarks(path)).toEqual({})
  })
  it('unmarking a pane that was never marked fails clearly', () => {
    expect(act('P2', { kind: null })).toEqual({ status: 'failed', outcome: 'this pane was detected automatically, not marked' })
  })
  it('setting a kind needs this Mac\'s local exec consent', () => {
    expect(act('P1', { kind: 'devin' }, WRAPPER, { allowExec: false })).toEqual({ status: 'failed', outcome: MARK_NEEDS_EXEC })
    expect(MARK_NEEDS_EXEC).toBe('marking panes from HQ needs `termbus bridge --allow-exec` on this Mac')
    expect(loadMarks(path)).toEqual({})
  })
  it('the Conductor can never mark a pane, even with consent', () => {
    expect(act('P1', { kind: 'devin' }, WRAPPER, { origin: 'conductor' })).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/not the Conductor/) })
    expect(act('P1', { kind: 'devin' }, WRAPPER, { origin: 'user' }).status).toBe('done')
  })
  it('unmarking is always allowed — no consent, any origin', () => {
    act('P1', { kind: 'devin' })
    expect(act('P1', { kind: null }, WRAPPER, { allowExec: false, origin: 'conductor' })).toEqual({ status: 'done', outcome: 'unmarked' })
    expect(loadMarks(path)).toEqual({})
  })
  it('never marks an ssh / psql / shell pane remotely', () => {
    const r = act('P1', { kind: 'devin' }, { pid: 9, command: 'ssh prod', start: null })
    expect(r).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/refusing to mark "ssh" from HQ/) })
    expect(act('P1', { kind: 'devin' }, null)).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/nothing is running/) })
    expect(loadMarks(path)).toEqual({})
  })
  it('refuses unknown kinds, closed panes and junk without touching the file', () => {
    expect(act('P1', { kind: 'aider' })).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/unknown agent kind/) })
    expect(executeMark({ paneId: 'P9', payload: '{"kind":"devin"}' }, undefined, { allowExec: true }, path)).toEqual({
      status: 'failed',
      outcome: 'pane no longer exists',
    })
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
  it('the Conductor may not approve, reject or answer prompts', () => {
    for (const kind of ['approve', 'reject', 'answer'] as const) {
      expect(conductorRefusal({ kind, origin: 'conductor' })).toEqual({ status: 'failed', outcome: `only the user can ${kind} from HQ, not the Conductor` })
      expect(conductorRefusal({ kind, origin: 'user' })).toBeNull()
      expect(conductorRefusal({ kind })).toBeNull()
    }
    expect(conductorRefusal({ kind: 'send', origin: 'conductor' })).toBeNull()
  })
})
