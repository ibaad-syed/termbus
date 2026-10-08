import type { TranscriptQuestionItem } from '../transcripts/types.js'
import { looksLikeQuestionDialog, QUESTION_TAIL_LINES } from './idle.js'
import type { AgentKind, Backend } from './types.js'

/**
 * Answering an interactive question dialog by keystroke (Claude Code
 * AskUserQuestion, Codex request_user_input), verified against the screen at
 * every step.
 *
 * Key schemes (verified live, Claude Code 2.1.288 / codex-cli 0.160.1, and
 * against codex-rs/tui/src/bottom_pane/request_user_input):
 *
 * Claude — tabbed dialog `← ☐ Q1  ☐ Q2  ✔ Submit →`, focus starts on option 1:
 *   single-select   digit N selects option N and advances to the next tab
 *   "Type something" digit (n+1) focuses the text row, type, Enter advances
 *   multi-select    digit N toggles option N ([ ] ↔ [✔]) without moving focus;
 *                   Right arrow advances. (Free text on a multi-select question
 *                   needs cursor navigation onto the text row, which can't be
 *                   verified reliably — see below — so HQ doesn't offer it.)
 *   review tab      shown after the last question unless the dialog is a single
 *                   single-select question (then the digit submits at once);
 *                   lists `● question → answer`; digit `1` = Submit answers
 *                   (digits pick by index, wherever the focus is)
 *
 * Claude repaint caveat (seen live, 2.1.288): the TUI sometimes applies a key
 * to its state but doesn't repaint until the NEXT key arrives (checkbox ticks,
 * tab changes). So list ticks are never trusted; the review tab — which lists
 * the exact answers from state — is checked before Submit; and when an
 * expected tab change hasn't painted, a Down arrow "nudge" forces a repaint.
 * Down is only used where focus is irrelevant (digits select by index).
 * Codex — `Question i/N (k unanswered)`, one question at a time, single-select:
 *   digit N         selects option N, advances; on the last question submits all
 *   "None of the above" + note: Up (wraps to the last row = None of the above),
 *                   Tab (notes), type, Enter (commits and advances/submits)
 *
 * Safety contract (same as approvals): before the first key the dialog on
 * screen must be the exact question (text + options in order) in its fresh,
 * nothing-answered state, else 'stale' and nothing is typed. Each step's keys
 * are only sent once the previous step's expected screen showed up; if the
 * screen ever diverges, typing stops before anything is submitted (the final
 * submit key is only sent behind an exact check of what will be submitted,
 * or — for a lone single-select question — is the one verified keypress).
 */

export interface QuestionAnswer {
  /** 0-based option indexes. Single-select: at most one. */
  selected: number[]
  /** free-text answer ("Type something" / "None of the above" note) */
  other?: string
}

export interface AnswerStep {
  label: string
  /** must hold on the current screen before this step's keys are sent */
  guard?: (screen: string) => boolean
  keys: string[]
  /** the screen this step must produce before the next one runs */
  expect: (screen: string) => boolean
  /** state-neutral keys sent once if `expect` hasn't painted yet (Claude repaint lag) */
  nudge?: string[]
}

const DOWN = '\u001b[B'
const UP = '\u001b[A'
const RIGHT = '\u001b[C'
const ENTER = '\r'
const TAB = '\t'

export const MAX_OTHER_CHARS = 500

/** Whitespace-free form: terminal wrapping and padding can't break a match. */
export function squash(s: string): string {
  return s.replace(/\s+/g, '')
}

/** Free text is typed into a TUI field: no control chars (a newline would submit, ESC would cancel). */
export function sanitizeOther(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_OTHER_CHARS)
}

/** The bottom of the screen where the dialog lives. */
function tailOf(screen: string): string[] {
  return screen.split('\n').slice(-QUESTION_TAIL_LINES)
}

/** Text of the dialog below its last header line (Claude tab bar / Codex progress line). */
function dialogBody(agent: AgentKind, screen: string): { header: string; body: string } | null {
  const lines = tailOf(screen)
  const isHeader =
    agent === 'claude'
      ? (l: string) => /^\s*(←\s+)?[☐☒]\s/.test(l) || /^\s*←\s.*Submit\s+→/.test(l)
      : (l: string) => /^\s*Question \d+\/\d+/.test(l)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isHeader(lines[i])) return { header: lines[i], body: lines.slice(i + 1).join('\n') }
  }
  return null
}

/** In-order containment of every needle in the squashed haystack. */
function inOrder(hay: string, needles: string[]): boolean {
  let at = 0
  for (const n of needles) {
    const i = hay.indexOf(n, at)
    if (i < 0) return false
    at = i + n.length
  }
  return true
}

function optionNeedles(agent: AgentKind, item: TranscriptQuestionItem): string[] {
  const box = item.multiSelect ? '[]' : ''
  const marker = agent === 'claude' ? '❯' : '›'
  const needles = item.options.map((o, i) => squash(`${i === 0 ? marker : ''}${i + 1}.${box}${o.label}`))
  const otherLabel = agent === 'claude' ? 'Type something' : 'None of the above'
  needles.push(squash(`${item.options.length + 1}.${box}${otherLabel}`))
  return needles
}

/** Is `item` the question currently shown (question text right below the header)? */
export function showsQuestion(agent: AgentKind, screen: string, item: TranscriptQuestionItem, index?: number, total?: number): boolean {
  if (!looksLikeQuestionDialog(agent, screen)) return false
  const d = dialogBody(agent, screen)
  if (!d) return false
  if (agent === 'codex' && index !== undefined && total !== undefined) {
    if (!new RegExp(`Question ${index + 1}/${total}\\b`).test(d.header)) return false
  }
  return squash(d.body).startsWith(squash(item.question))
}

/**
 * The dialog for `items` is on screen in its untouched state: first question
 * showing, nothing answered, options identical and in order, focus on option 1.
 * Returns null when it matches, else the reason.
 */
export function verifyFreshDialog(agent: AgentKind, screen: string, items: TranscriptQuestionItem[]): string | null {
  if (!looksLikeQuestionDialog(agent, screen)) return 'no question dialog on screen'
  const d = dialogBody(agent, screen)
  if (!d) return 'question dialog header not found'
  if (agent === 'claude') {
    if (d.header.includes('☒')) return 'the question is already partly answered on screen'
    const boxes = (d.header.match(/☐/g) ?? []).length
    if (boxes !== items.length) return `screen shows ${boxes} questions, expected ${items.length}`
  } else {
    const n = items.length
    if (!new RegExp(`Question 1/${n} \\(${n} unanswered\\)`).test(d.header)) {
      return 'a different (or partly answered) question is showing'
    }
  }
  const body = squash(d.body)
  if (!body.startsWith(squash(items[0].question))) return 'a different question is showing'
  if (!inOrder(body, optionNeedles(agent, items[0]))) return 'the options on screen differ from the question'
  return null
}

/** Answer text as the agent records it (Claude's review tab shows the same). */
export function expectedAnswerText(item: TranscriptQuestionItem, a: QuestionAnswer): string {
  const parts = a.selected.map((i) => item.options[i].label)
  if (a.other) parts.push(a.other)
  return parts.join(', ')
}

/** Claude review tab lists exactly these answers (and offers `1. Submit answers`). */
export function claudeReviewMatches(screen: string, items: TranscriptQuestionItem[], answers: QuestionAnswer[]): boolean {
  const tail = squash(tailOf(screen).join('\n'))
  const start = tail.lastIndexOf('Reviewyouranswers')
  if (start < 0) return false
  const review = tail.slice(start)
  const end = review.indexOf('Readytosubmityouranswers?')
  if (end < 0) return false
  const listed = review.slice('Reviewyouranswers'.length, end)
  const expected = items.map((it, i) => squash(`●${it.question}→${expectedAnswerText(it, answers[i])}`)).join('')
  return listed === expected && review.slice(end).includes('1.Submitanswers')
}

/** Validate an answer set against the questions. Returns an error or null. */
export function validateAnswers(
  agent: AgentKind,
  items: TranscriptQuestionItem[],
  answers: QuestionAnswer[],
  allowOther: boolean,
): string | null {
  if (!Array.isArray(answers) || answers.length !== items.length) return 'one answer per question is required'
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const a = answers[i]
    if (!a || !Array.isArray(a.selected)) return `question ${i + 1}: malformed answer`
    const sel = a.selected
    if (sel.some((x) => !Number.isInteger(x) || x < 0 || x >= item.options.length)) return `question ${i + 1}: no such option`
    if (new Set(sel).size !== sel.length) return `question ${i + 1}: duplicate option`
    if (item.options.length > 8) return `question ${i + 1}: too many options to select by key`
    const other = a.other !== undefined ? sanitizeOther(a.other) : undefined
    if (a.other !== undefined && !other) return `question ${i + 1}: empty free-text answer`
    if (other && !allowOther) return `question ${i + 1}: free text is not offered`
    if (item.multiSelect) {
      if (agent !== 'claude') return `question ${i + 1}: multi-select is Claude-only`
      if (other) return `question ${i + 1}: free text on a multi-select question isn't supported remotely`
      if (sel.length === 0) return `question ${i + 1}: pick at least one option`
    } else {
      if (sel.length + (other ? 1 : 0) !== 1) return `question ${i + 1}: pick exactly one option`
    }
  }
  return null
}

const digit = (n: number) => String(n)

/**
 * Plan the keystrokes for a validated answer set. Pure: the steps carry their
 * own screen guards/expectations; runAnswerSteps executes them.
 */
export function planAnswerSteps(agent: AgentKind, items: TranscriptQuestionItem[], raw: QuestionAnswer[]): AnswerStep[] {
  const answers = raw.map((a) => ({
    selected: [...a.selected].sort((x, y) => x - y),
    ...(a.other !== undefined ? { other: sanitizeOther(a.other) } : {}),
  }))
  const n = items.length
  const steps: AnswerStep[] = []
  const claudeReview = agent === 'claude' && (n > 1 || items[0].multiSelect)
  const gone = (s: string) => !looksLikeQuestionDialog(agent, s)

  for (let i = 0; i < n; i++) {
    const item = items[i]
    const a = answers[i]
    const here = (s: string) => showsQuestion(agent, s, item, i, n)
    const advanced =
      i + 1 < n
        ? (s: string) => showsQuestion(agent, s, items[i + 1], i + 1, n)
        : claudeReview
          ? (s: string) => squash(tailOf(s).join('\n')).includes('Reviewyouranswers')
          : gone
    const optCount = item.options.length
    const otherRow = optCount + 1

    // Claude repaint lag: a tab change may not paint until the next key. Down is
    // a safe nudge there — the next tab is answered by index (digits), and on
    // the review tab Submit is pressed by its digit too.
    const nudge = agent === 'claude' ? [DOWN] : undefined

    if (agent === 'claude' && item.multiSelect) {
      // List ticks are NOT checked (they often don't repaint); the review tab
      // verifies the exact selection before Submit is pressed.
      for (const k of a.selected) {
        steps.push({ label: `Q${i + 1}: toggle option ${k + 1}`, guard: here, keys: [digit(k + 1)], expect: here })
      }
      steps.push({ label: `Q${i + 1}: next`, guard: here, keys: [RIGHT], expect: advanced, nudge })
      continue
    }

    if (a.other) {
      const text = a.other
      if (agent === 'claude') {
        steps.push({ label: `Q${i + 1}: focus "Type something"`, guard: here, keys: [digit(otherRow)], expect: (s) => here(s) && squash(s).includes(squash(`❯${otherRow}.`)) })
        steps.push({ label: `Q${i + 1}: type free text`, keys: [text], expect: (s) => here(s) && squash(s).includes(squash(`❯${otherRow}.${text}`)) })
      } else {
        steps.push({ label: `Q${i + 1}: focus "None of the above"`, guard: here, keys: [UP], expect: (s) => here(s) && squash(s).includes(squash(`›${otherRow}.None of the above`)) })
        steps.push({ label: `Q${i + 1}: open notes`, keys: [TAB], expect: (s) => here(s) && squash(s).includes(squash(`›${otherRow}.None of the above`)) })
        steps.push({ label: `Q${i + 1}: type note`, keys: [text], expect: (s) => here(s) && squash(s).includes(squash(text)) })
      }
      steps.push({ label: `Q${i + 1}: commit free text`, keys: [ENTER], expect: advanced, ...(advanced === gone ? {} : { nudge }) })
    } else {
      const k = a.selected[0]
      steps.push({ label: `Q${i + 1}: pick option ${k + 1}`, guard: here, keys: [digit(k + 1)], expect: advanced, ...(advanced === gone ? {} : { nudge }) })
    }
  }

  if (claudeReview) {
    steps.push({
      label: 'submit answers',
      guard: (s) => claudeReviewMatches(s, items, answers),
      keys: ['1'],
      expect: gone,
    })
  }
  return steps
}

export interface StepClock {
  sleep(ms: number): Promise<void>
  now(): number
}

export interface RunOptions {
  pollMs?: number
  timeoutMs?: number
  /** pause between keys within one step (TUIs drop keys sent back-to-back) */
  keyGapMs?: number
  /** pause after each verified step before the next one */
  settleMs?: number
  /** how long to wait for a paint before sending a step's nudge */
  nudgeAfterMs?: number
}

export type AnswerOutcome = { status: 'done' | 'stale' | 'failed'; outcome: string }

/**
 * Execute planned steps against a pane. 'stale' means nothing was typed;
 * 'failed' means typing stopped partway (before the final submit), leaving
 * the dialog open for the user.
 */
export async function runAnswerSteps(
  backend: Pick<Backend, 'readScreen' | 'sendText'>,
  paneId: string,
  steps: AnswerStep[],
  clock: StepClock,
  opts: RunOptions = {},
): Promise<AnswerOutcome> {
  const pollMs = opts.pollMs ?? 250
  const timeoutMs = opts.timeoutMs ?? 4000
  const keyGapMs = opts.keyGapMs ?? 350
  // pause after each verified step: Claude drops/merges digits that arrive
  // within ~0.6s of the previous one (seen live), so steps are paced
  const settleMs = opts.settleMs ?? 900
  const nudgeAfterMs = opts.nudgeAfterMs ?? 1500
  let screen = await backend.readScreen(paneId)
  let typed = false
  for (const step of steps) {
    if (step.guard && !step.guard(screen)) {
      return typed
        ? { status: 'failed', outcome: `stopped before "${step.label}": the dialog no longer matched — nothing was submitted, finish it on the Mac` }
        : { status: 'stale', outcome: 'the question on screen changed — nothing was typed' }
    }
    for (let k = 0; k < step.keys.length; k++) {
      if (k > 0) await clock.sleep(keyGapMs)
      await backend.sendText(paneId, step.keys[k], false)
      typed = true
    }
    const started = clock.now()
    let nudged = false
    for (;;) {
      await clock.sleep(pollMs)
      screen = await backend.readScreen(paneId)
      if (step.expect(screen)) break
      if (step.nudge && !nudged && clock.now() - started >= nudgeAfterMs) {
        nudged = true
        for (const key of step.nudge) await backend.sendText(paneId, key, false)
        continue
      }
      if (clock.now() - started >= timeoutMs) {
        const last = step === steps[steps.length - 1]
        return {
          status: 'failed',
          outcome: last
            ? `"${step.label}" was sent but the dialog hasn't closed yet — check the pane`
            : `"${step.label}" did not register as expected — typing stopped, nothing was submitted; check the pane`,
        }
      }
    }
    await clock.sleep(settleMs)
  }
  return { status: 'done', outcome: 'answered' }
}
