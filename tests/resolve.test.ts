import { describe, expect, it } from 'vitest'
import { AmbiguousTargetError, TargetNotFoundError } from '../src/core/errors.js'
import { resolveTarget } from '../src/core/resolve.js'
import type { Pane } from '../src/core/types.js'

function pane(over: Partial<Pane>): Pane {
  return {
    id: 'UUID-DEFAULT',
    label: 'w1.t1.p1',
    title: 'Default (-zsh)',
    tty: '/dev/ttys001',
    isSelf: false,
    windowIndex: 1,
    tabIndex: 1,
    paneIndex: 1,
    ...over,
  }
}

const PANES: Pane[] = [
  pane({ id: 'AAA', label: 'w1.t1.p1', title: 'reviewer claude', tty: '/dev/ttys001', isSelf: true }),
  pane({ id: 'BBB', label: 'w1.t1.p2', title: 'worker claude', tty: '/dev/ttys002', paneIndex: 2 }),
  pane({ id: 'CCC', label: 'w2.t1.p1', title: 'dev server', tty: '/dev/ttys003', windowIndex: 2 }),
]

describe('resolveTarget', () => {
  it('resolves exact session id', () => {
    expect(resolveTarget(PANES, 'BBB').label).toBe('w1.t1.p2')
  })
  it('resolves label case-insensitively', () => {
    expect(resolveTarget(PANES, 'W2.T1.P1').id).toBe('CCC')
  })
  it('resolves "self"', () => {
    expect(resolveTarget(PANES, 'self').id).toBe('AAA')
  })
  it('resolves tty with or without /dev/', () => {
    expect(resolveTarget(PANES, 'ttys003').id).toBe('CCC')
    expect(resolveTarget(PANES, '/dev/ttys002').id).toBe('BBB')
  })
  it('resolves unique title substring', () => {
    expect(resolveTarget(PANES, 'server').id).toBe('CCC')
  })
  it('throws AmbiguousTargetError on multi-match substring', () => {
    expect(() => resolveTarget(PANES, 'claude')).toThrow(AmbiguousTargetError)
  })
  it('throws TargetNotFoundError on no match', () => {
    expect(() => resolveTarget(PANES, 'nope')).toThrow(TargetNotFoundError)
  })
})
