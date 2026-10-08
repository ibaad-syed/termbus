import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyQuestionEvents, type OpenQuestion } from '../src/commands/bridge-transcripts.js'
import { agentScreenState, looksLikeQuestionDialog } from '../src/core/idle.js'
import {
  claudeReviewMatches,
  planAnswerSteps,
  runAnswerSteps,
  sanitizeOther,
  validateAnswers,
  verifyFreshDialog,
  type QuestionAnswer,
} from '../src/core/question.js'
import { createClaudeContext, parseClaudeLine } from '../src/transcripts/claude.js'
import { createCodexContext, parseCodexLine } from '../src/transcripts/codex.js'
import type { TranscriptEvent, TranscriptQuestionItem } from '../src/transcripts/types.js'
import * as S from './fixtures/question-screens.js'

function lines(name: string): string[] {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n').filter(Boolean)
}

function parseClaude(): TranscriptEvent[] {
  const ctx = createClaudeContext('s-claude')
  return lines('question-claude.jsonl').flatMap((l, i) => parseClaudeLine(l, i, ctx) ?? [])
}
function parseCodex(): TranscriptEvent[] {
  const ctx = createCodexContext()
  return lines('question-codex.jsonl').flatMap((l, i) => parseCodexLine(l, i, ctx) ?? [])
}

describe('Claude AskUserQuestion → question events (real transcript lines)', () => {
  const events = parseClaude()

  it('emits tool_call then question for each AskUserQuestion, keeping the old tool_call', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
    ])
    expect(events[0].tool?.name).toBe('AskUserQuestion')
    expect(events[1].subSeq).toBe(1)
  })

  it('question carries items with options, multiSelect, and the tool_use id', () => {
    const q = events[1].question!
    expect(q.callId).toBe('toolu_01FawpxUBiafaMNjq1sJaHSz')
    expect(q.allowOther).toBe(true)
    expect(q.items).toEqual([
      {
        key: 'Pick a color?',
        header: 'Color',
        question: 'Pick a color?',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'A warm, vibrant hue' },
          { label: 'Green', description: 'A cool, natural color' },
          { label: 'Blue', description: 'A calm, peaceful tone' },
        ],
      },
      {
        key: 'Pick toppings?',
        header: 'Toppings',
        question: 'Pick toppings?',
        multiSelect: true,
        options: [
          { label: 'Cheese', description: 'Melted and creamy' },
          { label: 'Olives', description: 'Tangy and briny' },
          { label: 'Basil', description: 'Fresh and aromatic' },
        ],
      },
    ])
  })

  it('the answering tool_result resolves the question with structured answers', () => {
    expect(events[2].question).toEqual({
      callId: 'toolu_01FawpxUBiafaMNjq1sJaHSz',
      answers: { 'Pick a color?': 'Green', 'Pick toppings?': 'Cheese, Basil, Olives' },
    })
    expect(events[14].question?.answers).toEqual({ 'Which languages?': 'Rust, Kotlin' }) // free text
  })

  it('an answer is recognized even when the tool_use was parsed by an earlier (restarted) tailer', () => {
    const ctx = createClaudeContext('s')
    const answerLine = lines('question-claude.jsonl')[1]
    const out = parseClaudeLine(answerLine, 0, ctx)!
    expect(out[0].tool?.name).toBe('AskUserQuestion')
    expect(out[0].question?.answers).toEqual({ 'Pick a color?': 'Green', 'Pick toppings?': 'Cheese, Basil, Olives' })
  })

  it('a dismissed question (is_error) resolves as declined', () => {
    expect(events[5].question).toEqual({ callId: 'toolu_01PUekEVK5zjnhQX2ahPUo3T', declined: true })
  })
})

describe('Codex request_user_input → question events (real rollout lines)', () => {
  const events = parseCodex()

  it('emits tool_call then question, then a resolving tool_result', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'session_start',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
      'tool_call', 'question', 'tool_result',
    ])
  })

  it('items are keyed by question id and single-select', () => {
    const q = events[2].question!
    expect(q.callId).toBe('call_39c88ac0b7a7415f9cc313e16c16d55c')
    expect(q.items!.map((i) => [i.key, i.header, i.question, i.multiSelect, i.options.map((o) => o.label)])).toEqual([
      ['color', 'Color', 'Pick a color?', false, ['Red', 'Green', 'Blue']],
      ['size', 'Size', 'Pick a size?', false, ['Small', 'Large']],
    ])
  })

  it('answers (including user notes) are flattened per question id', () => {
    expect(events[3].question).toEqual({
      callId: 'call_39c88ac0b7a7415f9cc313e16c16d55c',
      answers: { color: 'Green', size: 'Large' },
    })
    expect(events[6].question?.answers).toEqual({
      size: 'Small',
      pet: 'None of the above · user_note: yoyo',
      city: 'None of the above · user_note: sldfkjdas',
    })
  })

  it('an answer is recognized even when the call was parsed by an earlier (restarted) tailer', () => {
    const out = parseCodexLine(lines('question-codex.jsonl')[2], 0, createCodexContext('s'))!
    expect(out[0].tool?.name).toBe('request_user_input')
    expect(out[0].question?.answers).toEqual({ color: 'Green', size: 'Large' })
  })

  it('an all-empty answer set (auto-resolved / skipped) reads as declined', () => {
    const ctx = createCodexContext('s')
    parseCodexLine(JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'c1', arguments: '{"questions":[{"id":"a","header":"A","question":"Q?","options":[{"label":"x","description":""}]}]}' } }), 0, ctx)
    const out = parseCodexLine(JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"answers":{"a":{"answers":[]}}}' } }), 1, ctx)
    expect(out?.[0].question).toEqual({ callId: 'c1', declined: true })
  })
})

describe('open-question tracking', () => {
  it('opens on question, closes on the matching tool_result', () => {
    const open = new Map<string, OpenQuestion>()
    const events = parseClaude()
    applyQuestionEvents(open, events.slice(0, 2))
    expect([...open.keys()]).toEqual(['toolu_01FawpxUBiafaMNjq1sJaHSz'])
    expect(open.get('toolu_01FawpxUBiafaMNjq1sJaHSz')?.sessionId).toBe('f9425d53-5bc0-4c59-bd41-96bf07a88199')
    applyQuestionEvents(open, events.slice(2))
    expect(open.size).toBe(0)
  })
})

// ---- screen side -----------------------------------------------------------

const claudeItems = parseClaude()[1].question!.items! // Color (single) + Toppings (multi)
const fruit: TranscriptQuestionItem[] = [
  { key: 'Which fruit?', header: 'Fruit', question: 'Which fruit?', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Pear' }, { label: 'Plum' }] },
]
const codexItems: TranscriptQuestionItem[] = [
  { key: 'pet', header: 'Pet', question: 'Which pet?', multiSelect: false, options: [{ label: 'Cat' }, { label: 'Dog' }, { label: 'Fish' }] },
  { key: 'city', header: 'City', question: 'Which city?', multiSelect: false, options: [{ label: 'Paris' }, { label: 'Tokyo' }] },
  { key: 'size', header: 'Size', question: 'Which size?', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] },
]

describe('question dialog detection', () => {
  it('recognizes both TUIs and reports them as awaiting-input (codex despite "esc to interrupt")', () => {
    expect(looksLikeQuestionDialog('claude', S.CLAUDE_TWO_FRESH)).toBe(true)
    expect(looksLikeQuestionDialog('claude', S.CLAUDE_SINGLE_FRESH)).toBe(true)
    expect(looksLikeQuestionDialog('codex', S.CODEX_THREE_FRESH)).toBe(true)
    expect(agentScreenState('codex', S.CODEX_THREE_FRESH)).toBe('awaiting-input')
    expect(agentScreenState('claude', S.CLAUDE_TWO_FRESH)).toBe('awaiting-input')
  })
  it('recognizes the footer when a narrow (split) pane wraps it — seen live', () => {
    const narrow = S.CLAUDE_TWO_FRESH.replace(
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
      'Enter to select · Tab/Arrow keys to  \nnavigate · Esc to cancel',
    )
    expect(looksLikeQuestionDialog('claude', narrow)).toBe(true)
  })
  it('does not fire once the dialog is gone', () => {
    expect(looksLikeQuestionDialog('claude', S.CLAUDE_TWO_DONE)).toBe(false)
    expect(looksLikeQuestionDialog('codex', S.CODEX_DONE)).toBe(false)
    expect(agentScreenState('codex', S.CODEX_DONE)).toBe('busy')
  })
})

describe('verifyFreshDialog', () => {
  it('accepts the exact untouched dialog', () => {
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_FRESH, claudeItems)).toBeNull()
    expect(verifyFreshDialog('claude', S.CLAUDE_SINGLE_FRESH, fruit)).toBeNull()
    expect(verifyFreshDialog('codex', S.CODEX_THREE_FRESH, codexItems)).toBeNull()
  })
  it('rejects a partly answered dialog', () => {
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_ON_Q2, claudeItems)).toMatch(/partly answered/)
    expect(verifyFreshDialog('codex', S.CODEX_THREE_Q2, codexItems)).toMatch(/different/)
  })
  it('rejects a different question or reordered options', () => {
    const other = [{ ...claudeItems[0], question: 'Pick a colour?' }, claudeItems[1]]
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_FRESH, other)).toMatch(/different question/)
    const reordered = [{ ...claudeItems[0], options: [claudeItems[0].options[1], claudeItems[0].options[0], claudeItems[0].options[2]] }, claudeItems[1]]
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_FRESH, reordered)).toMatch(/options/)
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_FRESH, [claudeItems[0]])).toMatch(/2 questions/)
  })
  it('rejects screens without a dialog (or the other agent\'s)', () => {
    expect(verifyFreshDialog('claude', S.CLAUDE_TWO_DONE, claudeItems)).toMatch(/no question dialog/)
    expect(verifyFreshDialog('claude', S.CODEX_THREE_FRESH, codexItems)).toMatch(/no question dialog/)
  })
})

describe('validateAnswers', () => {
  it('enforces one choice for single-select and ≥1 for multi-select', () => {
    expect(validateAnswers('claude', claudeItems, [{ selected: [1] }, { selected: [0, 2] }], true)).toBeNull()
    expect(validateAnswers('claude', claudeItems, [{ selected: [0, 1] }, { selected: [0] }], true)).toMatch(/exactly one/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [] }, { selected: [0] }], true)).toMatch(/exactly one/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [1] }, { selected: [] }], true)).toMatch(/at least one/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [1] }], true)).toMatch(/one answer per question/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [7] }, { selected: [0] }], true)).toMatch(/no such option/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [], other: 'Teal' }, { selected: [0] }], true)).toBeNull()
    // free text on a multi-select row needs unverifiable cursor navigation
    expect(validateAnswers('claude', claudeItems, [{ selected: [1] }, { selected: [0], other: 'Ham' }], true)).toMatch(/multi-select/)
    expect(validateAnswers('claude', claudeItems, [{ selected: [], other: '\n\u001b' }, { selected: [0] }], true)).toMatch(/empty free-text/)
    expect(validateAnswers('codex', codexItems, [{ selected: [0] }, { selected: [], other: 'Rome' }, { selected: [1] }], false)).toMatch(/not offered/)
  })
  it('sanitizes free text so it can never press Enter/Esc', () => {
    expect(sanitizeOther('a\nb\r\u001b[Bc\t d')).toBe('a b [Bc d')
  })
})

/** Tiny TUI simulator: a transition table from (screen, key) to the next screen. */
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

describe('planAnswerSteps + runAnswerSteps', () => {
  it('Claude single + multi: digit, toggles, Right, verified review, Submit', async () => {
    const answers: QuestionAnswer[] = [{ selected: [1] }, { selected: [2, 0] }]
    const pane = fakePane(S.CLAUDE_TWO_FRESH, (screen, key) => {
      if (screen === S.CLAUDE_TWO_FRESH && key === '2') return S.claudeQ2With({})
      if (key === '1' && screen.includes('Pick toppings?') && !screen.includes('Review')) return S.claudeQ2With({ cheese: true })
      if (key === '3' && screen.includes('[✔] Cheese')) return S.claudeQ2With({ cheese: true, basil: true })
      if (key === '\u001b[C') return S.claudeTwoReview('Cheese, Basil')
      if (key === '1' && screen.includes('Review your answers')) return S.CLAUDE_TWO_DONE
      return screen
    })
    const steps = planAnswerSteps('claude', claudeItems, answers)
    const res = await runAnswerSteps(pane.backend, 'p', steps, fastClock())
    expect(res).toEqual({ status: 'done', outcome: 'answered' })
    expect(pane.sent).toEqual(['2', '1', '3', '\u001b[C', '1'])
  })

  it('Claude repaint lag: unpainted ticks are fine, an unpainted tab change gets one Down nudge', async () => {
    // live behaviour (2.1.288): state updates, the screen repaints only on the next key
    const answers: QuestionAnswer[] = [{ selected: [1] }, { selected: [0, 2] }]
    let pendingTab = false
    const pane = fakePane(S.CLAUDE_TWO_FRESH, (screen, key) => {
      if (screen === S.CLAUDE_TWO_FRESH && key === '2') {
        pendingTab = true // Q2 is active but not painted yet
        return screen
      }
      if (pendingTab && key === '\u001b[B') {
        pendingTab = false
        return S.claudeQ2With({}) // the nudge paints the new tab
      }
      if (key === '1' && !screen.includes('Review')) return screen // tick not painted
      if (key === '3' && !screen.includes('Review')) return screen // tick not painted
      if (key === '\u001b[C') return S.claudeTwoReview('Cheese, Basil').replace('❯ 1. Submit', '  1. Submit').replace('  2. Cancel', '❯ 2. Cancel')
      if (key === '1' && screen.includes('Review your answers')) return S.CLAUDE_TWO_DONE
      return screen
    })
    const res = await runAnswerSteps(pane.backend, 'p', planAnswerSteps('claude', claudeItems, answers), fastClock())
    expect(res).toEqual({ status: 'done', outcome: 'answered' })
    // Down nudged once; Submit is pressed by digit even with focus on Cancel
    expect(pane.sent).toEqual(['2', '\u001b[B', '1', '3', '\u001b[C', '1'])
  })

  it('Codex never gets nudges: an unpainted step fails closed', async () => {
    const pane = fakePane(S.CODEX_THREE_FRESH, (s) => s)
    const res = await runAnswerSteps(pane.backend, 'p', planAnswerSteps('codex', codexItems, [{ selected: [1] }, { selected: [0] }, { selected: [1] }]), fastClock())
    expect(res.status).toBe('failed')
    expect(pane.sent).toEqual(['2'])
  })

  it('Claude: refuses to submit when the review shows different answers', async () => {
    const answers: QuestionAnswer[] = [{ selected: [1] }, { selected: [0] }]
    const pane = fakePane(S.CLAUDE_TWO_FRESH, (screen, key) => {
      if (screen === S.CLAUDE_TWO_FRESH && key === '2') return S.claudeQ2With({})
      if (key === '1' && !screen.includes('Review')) return S.claudeQ2With({ cheese: true })
      if (key === '\u001b[C') return S.claudeTwoReview('Cheese, Olives') // a stray toggle landed
      return S.CLAUDE_TWO_DONE
    })
    const res = await runAnswerSteps(pane.backend, 'p', planAnswerSteps('claude', claudeItems, answers), fastClock())
    expect(res.status).toBe('failed')
    expect(res.outcome).toMatch(/nothing was submitted/)
    expect(pane.sent).toEqual(['2', '1', '\u001b[C']) // never pressed Submit
  })

  it('Claude single question with free text: focus row, type, Enter (no review tab)', async () => {
    const pane = fakePane(S.CLAUDE_SINGLE_FRESH, (screen, key) => {
      if (key === '4') return S.CLAUDE_SINGLE_OTHER_FOCUSED
      if (key === 'Mango, ripe') return S.CLAUDE_SINGLE_OTHER_TYPED
      if (key === '\r') return S.CLAUDE_TWO_DONE
      return screen
    })
    const steps = planAnswerSteps('claude', fruit, [{ selected: [], other: 'Mango,\nripe' }])
    expect(await runAnswerSteps(pane.backend, 'p', steps, fastClock())).toEqual({ status: 'done', outcome: 'answered' })
    expect(pane.sent).toEqual(['4', 'Mango, ripe', '\r'])
  })

  it('Codex: one digit per question; the last digit submits all', async () => {
    const pane = fakePane(S.CODEX_THREE_FRESH, (screen, key) => {
      if (screen === S.CODEX_THREE_FRESH && key === '2') return S.CODEX_THREE_Q2
      if (screen === S.CODEX_THREE_Q2 && key === '1') return S.CODEX_THREE_Q3
      if (screen === S.CODEX_THREE_Q3 && key === '2') return S.CODEX_DONE
      return screen
    })
    const steps = planAnswerSteps('codex', codexItems, [{ selected: [1] }, { selected: [0] }, { selected: [1] }])
    expect(await runAnswerSteps(pane.backend, 'p', steps, fastClock())).toEqual({ status: 'done', outcome: 'answered' })
    expect(pane.sent).toEqual(['2', '1', '2'])
  })

  it('Codex free text: Up to "None of the above", Tab, type, Enter', () => {
    const steps = planAnswerSteps('codex', codexItems, [{ selected: [0] }, { selected: [], other: 'Rome' }, { selected: [0] }])
    expect(steps.flatMap((s) => s.keys)).toEqual(['1', '\u001b[A', '\t', 'Rome', '\r', '1'])
  })

  it('stops typing the moment the screen diverges (a key was dropped)', async () => {
    const pane = fakePane(S.CODEX_THREE_FRESH, (screen, key) => (screen === S.CODEX_THREE_FRESH && key === '2' ? S.CODEX_THREE_Q2 : screen))
    const steps = planAnswerSteps('codex', codexItems, [{ selected: [1] }, { selected: [0] }, { selected: [1] }])
    const res = await runAnswerSteps(pane.backend, 'p', steps, fastClock())
    expect(res.status).toBe('failed')
    expect(pane.sent).toEqual(['2', '1']) // the third (submitting) key was never sent
  })

  it('nothing is typed when the first guard fails', async () => {
    const pane = fakePane(S.CODEX_THREE_Q2, (s) => s)
    const res = await runAnswerSteps(pane.backend, 'p', planAnswerSteps('codex', codexItems, [{ selected: [1] }, { selected: [0] }, { selected: [1] }]), fastClock())
    expect(res.status).toBe('stale')
    expect(pane.sent).toEqual([])
  })

  it('claudeReviewMatches is exact (no extra or missing answers)', () => {
    const answers: QuestionAnswer[] = [{ selected: [1] }, { selected: [0, 2] }]
    expect(claudeReviewMatches(S.claudeTwoReview('Cheese, Basil'), claudeItems, answers)).toBe(true)
    expect(claudeReviewMatches(S.claudeTwoReview('Cheese'), claudeItems, answers)).toBe(false)
    expect(claudeReviewMatches(S.claudeTwoReview('Cheese, Basil, Olives'), claudeItems, answers)).toBe(false)
  })
})
