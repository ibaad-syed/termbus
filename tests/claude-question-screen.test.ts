import { describe, expect, it } from 'vitest'
import { executeScreenAnswer, parseClaudeQuestionScreen, parseScreenCallId, screenCallId, validateScreenAnswer } from '../src/core/claude-question-screen.js'
import { TranscriptFeeder } from '../src/commands/bridge-transcripts.js'
import { looksLikeQuestionDialog } from '../src/core/idle.js'
import * as S from './fixtures/question-screens.js'

describe('parseClaudeQuestionScreen (real captures)', () => {
  it('single-select step with descriptions and the "Type something." row', () => {
    const p = parseClaudeQuestionScreen(S.CLAUDE_TWO_FRESH)
    expect(p).toMatchObject({
      step: 'question',
      tabs: [
        { header: 'Color', answered: false },
        { header: 'Toppings', answered: false },
      ],
      question: 'Pick a color?',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm, vibrant hue' },
        { label: 'Green', description: 'A cool, natural color' },
        { label: 'Blue', description: 'A calm, peaceful tone' },
      ],
    })
    expect(p && 'otherText' in p).toBe(false)
  })

  it('multi-select step: boxes, ticks, the Submit row is not an option', () => {
    const p = parseClaudeQuestionScreen(S.claudeQ2With({ cheese: true }))
    expect(p).toMatchObject({
      step: 'question',
      tabs: [{ header: 'Color', answered: true }, { header: 'Toppings', answered: true }],
      question: 'Pick toppings?',
      multiSelect: true,
      options: [
        { label: 'Cheese', description: 'Melted and creamy', ticked: true },
        { label: 'Olives', description: 'Tangy and briny', ticked: false },
        { label: 'Basil', description: 'Fresh and aromatic', ticked: false },
      ],
    })
  })

  it('lone question (no arrows in the tab bar)', () => {
    const p = parseClaudeQuestionScreen(S.CLAUDE_SINGLE_FRESH)
    expect(p).toMatchObject({ step: 'question', tabs: [{ header: 'Fruit', answered: false }], question: 'Which fruit?' })
    expect(p?.step === 'question' && p.options.map((o) => o.label)).toEqual(['Apple', 'Pear', 'Plum'])
  })

  it('typed free text is reported, not mistaken for an option', () => {
    const p = parseClaudeQuestionScreen(S.CLAUDE_SINGLE_OTHER_TYPED)
    expect(p).toMatchObject({ step: 'question', otherText: 'Mango, ripe' })
    expect(p?.step === 'question' && p.options).toHaveLength(3)
  })

  it('narrow split pane: wrapped question, long wrapped descriptions, wrapped footer', () => {
    const p = parseClaudeQuestionScreen(S.CLAUDE_NARROW_FRESH)
    expect(p).toMatchObject({
      step: 'question',
      question: 'Pick a color for the new dashboard theme, keeping accessibility in mind?',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm color that draws attention to alerts and errors' },
        { label: 'Green', description: 'The color green' },
        { label: 'Blue', description: 'The color blue' },
      ],
    })
  })

  it('review tab', () => {
    const p = parseClaudeQuestionScreen(S.claudeTwoReview('Cheese, Basil'))
    expect(p).toMatchObject({
      step: 'review',
      review: [
        { question: 'Pick a color?', answer: 'Green' },
        { question: 'Pick toppings?', answer: 'Cheese, Basil' },
      ],
    })
  })

  it('fingerprint is stable for the same step and changes with any visible change', () => {
    const a = parseClaudeQuestionScreen(S.CLAUDE_TWO_FRESH)!.fingerprint
    expect(parseClaudeQuestionScreen(S.CLAUDE_TWO_FRESH + '\n')?.fingerprint).toBe(a)
    expect(parseClaudeQuestionScreen(S.CLAUDE_TWO_FRESH.replace('A cool, natural color', 'A cool colour'))?.fingerprint).not.toBe(a)
    expect(parseClaudeQuestionScreen(S.claudeQ2With({}))!.fingerprint).not.toBe(parseClaudeQuestionScreen(S.claudeQ2With({ basil: true }))!.fingerprint)
  })

  it('finding 6: a TodoWrite list above another picker is not a question dialog', () => {
    expect(looksLikeQuestionDialog('claude', S.CLAUDE_TODOS_ABOVE_PICKER)).toBe(false)
    expect(parseClaudeQuestionScreen(S.CLAUDE_TODOS_ABOVE_PICKER)).toBeNull()
    // and a todo list above a REAL question doesn't confuse the tab bar
    const both = S.CLAUDE_TODOS_ABOVE_PICKER.split('\n').slice(0, 5).join('\n') + '\n' + S.CLAUDE_TWO_FRESH
    expect(parseClaudeQuestionScreen(both)).toMatchObject({ step: 'question', question: 'Pick a color?', tabs: [{ header: 'Color' }, { header: 'Toppings' }] })
  })

  it('returns null for non-dialog screens and codex dialogs', () => {
    expect(parseClaudeQuestionScreen(S.CLAUDE_TWO_DONE)).toBeNull()
    expect(parseClaudeQuestionScreen(S.CODEX_THREE_FRESH)).toBeNull()
  })
})

// ---- answering a screen step ------------------------------------------------

function fakePane(start: string, transition: (screen: string, key: string) => string) {
  let screen = start
  const sent: string[] = []
  return {
    sent,
    backend: {
      async readScreen() {
        return screen
      },
      async sendText(_id: string, text: string) {
        sent.push(text)
        screen = transition(screen, text)
      },
    },
  }
}
const fastClock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}
const idOf = (screen: string) => screenCallId('p', 'n0nce', parseClaudeQuestionScreen(screen)!.fingerprint)

describe('executeScreenAnswer', () => {
  it('lone single-select question: one digit, dialog closes', async () => {
    const pane = fakePane(S.CLAUDE_SINGLE_FRESH, (s, k) => (k === '2' ? S.CLAUDE_TWO_DONE : s))
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(S.CLAUDE_SINGLE_FRESH), { selected: [1] }, fastClock())
    expect(r).toEqual({ status: 'done', outcome: 'answered' })
    expect(pane.sent).toEqual(['2'])
  })

  it('stale when the step on screen is not the card\'s step — nothing typed', async () => {
    const pane = fakePane(S.claudeQ2With({}), (s) => s)
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(S.CLAUDE_TWO_FRESH), { selected: [1] }, fastClock())
    expect(r.status).toBe('stale')
    expect(pane.sent).toEqual([])
  })

  it('first of two questions: digit, and a Down nudge when the next tab does not paint', async () => {
    let pending = false
    const pane = fakePane(S.CLAUDE_TWO_FRESH, (s, k) => {
      if (k === '2' && s === S.CLAUDE_TWO_FRESH) {
        pending = true // state moved to Q2, screen not repainted (seen live)
        return s
      }
      if (k === '\u001b[B' && pending) return S.claudeQ2With({})
      return s
    })
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(S.CLAUDE_TWO_FRESH), { selected: [1] }, fastClock())
    expect(r.status).toBe('done')
    expect(pane.sent).toEqual(['2', '\u001b[B'])
  })

  it('multi-select: toggles only the difference from what was painted, then Right', async () => {
    const start = S.claudeQ2With({ cheese: true })
    const pane = fakePane(start, (s, k) => (k === '\u001b[C' ? S.claudeTwoReview('Cheese, Basil') : s)) // ticks never repaint
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(start), { selected: [0, 2] }, fastClock())
    expect(r.status).toBe('done')
    expect(pane.sent).toEqual(['3', '\u001b[C'])
  })

  it('review step: verified, then digit 1 submits', async () => {
    const review = S.claudeTwoReview('Cheese, Basil')
    const pane = fakePane(review, (s, k) => (k === '1' ? S.CLAUDE_TWO_DONE : s))
    expect(await executeScreenAnswer(pane.backend, 'p', idOf(review), { submit: true }, fastClock())).toEqual({ status: 'done', outcome: 'answered' })
    expect(pane.sent).toEqual(['1'])
  })

  it('free text on a single-select step: focus row by digit, type, Enter', async () => {
    const pane = fakePane(S.CLAUDE_SINGLE_FRESH, (s, k) => {
      if (k === '4') return S.CLAUDE_SINGLE_OTHER_FOCUSED
      if (k === 'Mango, ripe') return S.CLAUDE_SINGLE_OTHER_TYPED
      if (k === '\r') return S.CLAUDE_TWO_DONE
      return s
    })
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(S.CLAUDE_SINGLE_FRESH), { other: 'Mango, ripe' }, fastClock())
    expect(r.status).toBe('done')
    expect(pane.sent).toEqual(['4', 'Mango, ripe', '\r'])
  })

  it('free text never gets typed if the focus jump did not show', async () => {
    const pane = fakePane(S.CLAUDE_SINGLE_FRESH, (s) => s)
    const r = await executeScreenAnswer(pane.backend, 'p', idOf(S.CLAUDE_SINGLE_FRESH), { other: '2 cats' }, fastClock())
    expect(r.status).toBe('failed')
    expect(pane.sent).toEqual(['4'])
  })

  it('rejects invalid answers for the step', () => {
    const q = parseClaudeQuestionScreen(S.claudeQ2With({}))!
    expect(validateScreenAnswer(q, { selected: [0], other: 'x' })).toMatch(/multi-select/)
    expect(validateScreenAnswer(q, { selected: [] })).toMatch(/at least one/)
    expect(validateScreenAnswer(q, { submit: true })).toMatch(/not the review/)
    const r = parseClaudeQuestionScreen(S.claudeTwoReview('Cheese'))!
    expect(validateScreenAnswer(r, { selected: [0] })).toMatch(/review/)
  })
})

describe('finding 3: screen card ids are per pane and per occurrence', () => {
  it('id = screen:<paneId>:<nonce>:<fp>, round-trips', () => {
    expect(parseScreenCallId(screenCallId('P-1', 'abc', 'f00'))).toEqual({ paneId: 'P-1', nonce: 'abc', fingerprint: 'f00' })
    expect(parseScreenCallId('screen:f00')).toBeNull()
    expect(parseScreenCallId('toolu_123')).toBeNull()
  })

  it('the bridge compares only the step fingerprint, and only on the card\'s own pane', async () => {
    const fp = parseClaudeQuestionScreen(S.CLAUDE_SINGLE_FRESH)!.fingerprint
    const other = fakePane(S.CLAUDE_SINGLE_FRESH, (s) => s)
    expect((await executeScreenAnswer(other.backend, 'p', screenCallId('OTHER-PANE', 'x', fp), { selected: [0] }, fastClock())).status).toBe('stale')
    expect(other.sent).toEqual([])
    const mine = fakePane(S.CLAUDE_SINGLE_FRESH, (s, k) => (k === '1' ? S.CLAUDE_TWO_DONE : s))
    expect((await executeScreenAnswer(mine.backend, 'p', screenCallId('p', 'any-nonce', fp), { selected: [0] }, fastClock())).status).toBe('done')
  })

  function feederWithLinkedClaude(): TranscriptFeeder {
    const f = new TranscriptFeeder(async () => new Response('{}'))
    const info = { agent: 'claude' as const, sessionId: 'S1', path: '/x', lastActivity: 0, sizeBytes: 0 }
    ;(f as any).links = new Map([['S1', 'P1']])
    ;(f as any).tailers = new Map([['S1', { info, tailer: null }]])
    return f
  }

  it('the same dialog twice (or after a bridge restart) gets a new id and new event keys', () => {
    const q = parseClaudeQuestionScreen(S.CLAUDE_SINGLE_FRESH)!
    const a = feederWithLinkedClaude()
    const first = a.screenQuestionEvents('P1', q)
    a.screenQuestionEvents('P1', null) // answered/closed
    const second = a.screenQuestionEvents('P1', q) // the identical question again
    const restarted = feederWithLinkedClaude().screenQuestionEvents('P1', q) // fresh process, same screen
    const ids = [first, second, restarted].map((p) => p.find((e) => e.event.kind === 'question')!.event.question!.callId)
    expect(new Set(ids).size).toBe(3)
    const seqs = [first, second, restarted].map((p) => p.find((e) => e.event.kind === 'question')!.event.seq)
    expect(new Set(seqs).size).toBe(3)
    for (const id of ids) expect(parseScreenCallId(id)).toMatchObject({ paneId: 'P1', fingerprint: q.fingerprint })
  })
})
