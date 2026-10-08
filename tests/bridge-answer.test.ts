import { describe, expect, it } from 'vitest'
import { executeAnswer } from '../src/commands/bridge.js'
import type { OpenQuestion } from '../src/commands/bridge-transcripts.js'
import type { Backend, Pane } from '../src/core/types.js'
import * as S from './fixtures/question-screens.js'

const pane: Pane = { id: 'P1', label: 'w1.t1.p1', title: 'claude', tty: '/dev/ttys001', isSelf: false, windowIndex: 1, tabIndex: 1, paneIndex: 1 }

const fruit: OpenQuestion = {
  callId: 'toolu_fruit',
  sessionId: 'S1',
  agent: 'claude',
  allowOther: true,
  ts: '2026-10-08T00:00:00Z',
  items: [{ key: 'Which fruit?', header: 'Fruit', question: 'Which fruit?', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }] }],
}

function backend(screen: string) {
  const sent: string[] = []
  let cur = screen
  const b: Backend = {
    name: 'fake',
    listPanes: async () => [pane],
    readScreen: async () => cur,
    sendText: async (_id, text) => {
      sent.push(text)
      if (text === '2') cur = S.CLAUDE_TWO_DONE // the lone single-select digit submits
    },
  }
  return { b, sent }
}

function feeder(open: OpenQuestion | undefined, link?: string) {
  return { openQuestion: (id: string) => (open && open.callId === id ? open : undefined), linkedPane: () => link }
}

const clock = (() => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
})()

const payload = (o: unknown) => ({ payload: JSON.stringify(o) })

describe('executeAnswer (bridge kind=answer)', () => {
  it('answers a lone single-select question with one verified digit', async () => {
    const { b, sent } = backend(S.CLAUDE_SINGLE_FRESH)
    const r = await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_fruit', answers: [{ selected: [1] }] }), feeder(fruit, 'P1'), clock)
    expect(r).toEqual({ status: 'done', outcome: 'answered' })
    expect(sent).toEqual(['2'])
  })

  it('uses its own transcript copy of the question: unknown / already-answered callId is stale', async () => {
    const { b, sent } = backend(S.CLAUDE_SINGLE_FRESH)
    const r = await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_other', answers: [{ selected: [1] }] }), feeder(fruit, 'P1'), clock)
    expect(r.status).toBe('stale')
    expect(sent).toEqual([])
  })

  it('refuses when the question belongs to another pane or agent', async () => {
    const { b, sent } = backend(S.CLAUDE_SINGLE_FRESH)
    expect((await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_fruit', answers: [{ selected: [1] }] }), feeder(fruit, 'P2'), clock)).status).toBe('stale')
    expect((await executeAnswer(b, pane, 'codex', payload({ callId: 'toolu_fruit', answers: [{ selected: [1] }] }), feeder(fruit, 'P1'), clock)).status).toBe('stale')
    expect(sent).toEqual([])
  })

  it('types nothing when the screen shows something else', async () => {
    const { b, sent } = backend(S.CLAUDE_TWO_DONE)
    const r = await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_fruit', answers: [{ selected: [1] }] }), feeder(fruit, 'P1'), clock)
    expect(r.status).toBe('stale')
    expect(sent).toEqual([])
  })

  it('rejects malformed or invalid answers without touching the pane', async () => {
    const { b, sent } = backend(S.CLAUDE_SINGLE_FRESH)
    expect((await executeAnswer(b, pane, 'claude', { payload: 'nope' }, feeder(fruit, 'P1'), clock)).status).toBe('failed')
    expect((await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_fruit', answers: [{ selected: [0, 1] }] }), feeder(fruit, 'P1'), clock)).status).toBe('failed')
    expect((await executeAnswer(b, pane, 'claude', payload({ callId: 'toolu_fruit', answers: [{ selected: [1] }] }), null, clock)).status).toBe('failed')
    expect(sent).toEqual([])
  })
})
