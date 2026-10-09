import { createHash } from 'node:crypto'
import { findClaudeTabBar, looksLikeQuestionDialog, QUESTION_TAIL_LINES } from './idle.js'
import { runAnswerSteps, sanitizeOther, type AnswerOutcome, type AnswerStep, type StepClock } from './question.js'
import type { Backend } from './types.js'

/**
 * Claude Code's AskUserQuestion dialog, read off the SCREEN.
 *
 * Why the screen: Claude Code (2.1.288) does not write the AskUserQuestion
 * tool_use to its session JSONL until the dialog is answered or dismissed
 * (verified live: 0 occurrences while the dialog was up, 1 right after Esc),
 * so a transcript-built card can't exist while the question is pending.
 *
 * The dialog shows ONE tab at a time, so a screen card is one step of the
 * dialog: the visible question, or the review tab. Answering a step changes
 * the screen, the bridge parses the next step and posts the next card.
 *
 * Anatomy (80-col capture; narrower panes wrap every line):
 *
 *   ←  ☐ Color  ☐ Toppings  ✔ Submit  →      tab bar (lone question: " ☐ Fruit  ")
 *   Pick a color?                            question (may wrap)
 *   ❯ 1. Red                                 focus marker ❯, "N. label"
 *        A warm, vibrant hue                 description, indented
 *     4. Type something.                     free-text row (multi: "4. [ ] Type something")
 *        Submit | Next                       multi-select only
 *   ─────
 *     5. Chat about this
 *   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
 *
 * Review tab: "Review your answers", "● question" / "→ answer" pairs,
 * "Ready to submit your answers?", "1. Submit answers", "2. Cancel".
 */

export interface ScreenTab {
  header: string
  answered: boolean
}
export interface ScreenOption {
  label: string
  description?: string
  /** multi-select only: the row's box as painted (may lag state — see question.ts) */
  ticked?: boolean
}
export type ClaudeScreenQuestion =
  | {
      step: 'question'
      tabs: ScreenTab[]
      question: string
      multiSelect: boolean
      options: ScreenOption[]
      /** text already typed into the free-text row, if any */
      otherText?: string
      fingerprint: string
    }
  | {
      step: 'review'
      tabs: ScreenTab[]
      review: Array<{ question: string; answer: string }>
      fingerprint: string
    }

const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*)$/
const RULE_RE = /^\s*─{8,}\s*$/

function tabsOf(line: string): ScreenTab[] {
  const tabs: ScreenTab[] = []
  // tokens: "☐ Header" / "☒ Header" (headers ≤ 12 chars, may contain spaces)
  const re = /([☐☒])\s+(.+?)(?=\s{2,}|\s*[☐☒✔→]|\s*$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) tabs.push({ header: m[2].trim(), answered: m[1] === '☒' })
  return tabs
}

function fingerprintOf(o: unknown): string {
  return createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24)
}

/** Join wrapped lines of one logical text block. */
function joinWrapped(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse the visible AskUserQuestion step, or null if the screen isn't one
 * (or doesn't parse cleanly — callers then show no card: fail closed).
 */
export function parseClaudeQuestionScreen(screen: string): ClaudeScreenQuestion | null {
  if (!looksLikeQuestionDialog('claude', screen)) return null
  const lines = screen.split('\n').slice(-QUESTION_TAIL_LINES).map((l) => l.replace(/\s+$/, ''))

  // the dialog's tab bar (not TodoWrite's ☐/☒ lines — see findClaudeTabBar)
  const barIdx = findClaudeTabBar(lines)
  if (barIdx < 0) return null
  // a narrow pane wraps the tab bar: collect continuation lines up to the first blank
  let barEnd = barIdx + 1
  while (barEnd < lines.length && lines[barEnd].trim() && !OPTION_RE.test(lines[barEnd]) && /[☐☒✔→]/.test(lines[barEnd])) barEnd++
  const tabs = tabsOf(lines.slice(barIdx, barEnd).join('  '))
  if (tabs.length === 0) return null
  const body = lines.slice(barEnd)

  // ---- review tab
  const revIdx = body.findIndex((l) => /^\s*Review your answers\s*$/.test(l))
  if (revIdx >= 0) {
    const readyIdx = body.findIndex((l, i) => i > revIdx && /Ready to submit your answers\?/.test(l))
    if (readyIdx < 0) return null
    const review: Array<{ question: string; answer: string }> = []
    let cur: { q: string[]; a: string[] } | null = null
    let into: 'q' | 'a' = 'q'
    for (const l of body.slice(revIdx + 1, readyIdx)) {
      const t = l.trim()
      if (!t) continue
      if (t.startsWith('●')) {
        if (cur) review.push({ question: joinWrapped(cur.q), answer: joinWrapped(cur.a) })
        cur = { q: [t.slice(1)], a: [] }
        into = 'q'
      } else if (t.startsWith('→') && cur) {
        cur.a.push(t.slice(1))
        into = 'a'
      } else if (cur) {
        cur[into].push(t)
      }
    }
    if (cur) review.push({ question: joinWrapped(cur.q), answer: joinWrapped(cur.a) })
    const tail = body.slice(readyIdx).join('\n')
    if (!review.length || !/1\.\s+Submit answers/.test(tail)) return null
    return { step: 'review', tabs, review, fingerprint: fingerprintOf({ s: 'review', tabs, review }) }
  }

  // ---- question tab: question text = lines up to the first option row
  const firstOpt = body.findIndex((l) => OPTION_RE.test(l))
  if (firstOpt < 0) return null
  const question = joinWrapped(body.slice(0, firstOpt))
  if (!question) return null

  // option rows until the rule above "Chat about this"
  const rows: Array<{ n: number; first: string; rest: string[] }> = []
  for (const l of body.slice(firstOpt)) {
    if (RULE_RE.test(l)) break
    const m = l.match(OPTION_RE)
    if (m) rows.push({ n: Number(m[2]), first: m[3], rest: [] })
    else if (rows.length) rows[rows.length - 1].rest.push(l)
  }
  if (rows.length < 2) return null
  // numbering must be 1..N with no gaps (otherwise the parse is suspect)
  if (rows.some((r, i) => r.n !== i + 1)) return null

  const last = rows[rows.length - 1]
  const multiSelect = /^\[[ ✔]\]/.test(rows[0].first)
  const otherMatch = multiSelect ? last.first.match(/^\[([ ✔])\]\s*(.*)$/) : [null, null, last.first]
  if (!otherMatch) return null
  // free-text row: "Type something." (single) / "[ ] Type something" (multi), or typed text.
  // Multi-select's trailing "Submit"/"Next" row belongs to it as `rest`.
  const otherRowText = joinWrapped([otherMatch[2] ?? '', ...last.rest.filter((r) => !/^\s*(Submit|Next)\s*$/.test(r))])
  const otherIsPlaceholder = /^Type something\.?$/.test(otherRowText)

  const options: ScreenOption[] = rows.slice(0, -1).map((r) => {
    let label = r.first
    let ticked: boolean | undefined
    if (multiSelect) {
      const mm = label.match(/^\[([ ✔])\]\s*(.*)$/)
      if (!mm) return { label: '' }
      ticked = mm[1] === '✔'
      label = mm[2]
    }
    const description = joinWrapped(r.rest)
    return { label: label.trim(), ...(description ? { description } : {}), ...(multiSelect ? { ticked } : {}) }
  })
  if (options.some((o) => !o.label)) return null

  const parsed = {
    step: 'question' as const,
    tabs,
    question,
    multiSelect,
    options,
    ...(otherIsPlaceholder || !otherRowText ? {} : { otherText: otherRowText }),
  }
  return { ...parsed, fingerprint: fingerprintOf(parsed) }
}

/**
 * Screen-built card ids: `screen:<paneId>:<occurrence nonce>:<step fingerprint>`.
 * The pane and nonce make every showing of a step unique (the same dialog
 * asked twice, or seen again after a bridge restart, is a new card — never a
 * collision with an old card's one-time answer slot or event key); the bridge
 * only ever compares the fingerprint part against the screen.
 */
export const SCREEN_CALL_PREFIX = 'screen:'

export function screenCallId(paneId: string, nonce: string, fingerprint: string): string {
  return `${SCREEN_CALL_PREFIX}${paneId}:${nonce}:${fingerprint}`
}

export function parseScreenCallId(callId: string): { paneId: string; nonce: string; fingerprint: string } | null {
  if (!callId.startsWith(SCREEN_CALL_PREFIX)) return null
  const parts = callId.slice(SCREEN_CALL_PREFIX.length).split(':')
  if (parts.length !== 3 || parts.some((x) => !x)) return null
  const [paneId, nonce, fingerprint] = parts
  return { paneId, nonce, fingerprint }
}

// ---------------------------------------------------------------------------
// Answering one screen step
// ---------------------------------------------------------------------------

export interface ScreenAnswer {
  /** question step: 0-based option indexes to end up selected */
  selected?: number[]
  /** question step, single-select only: free text ("Type something") */
  other?: string
  /** review step: press "Submit answers" */
  submit?: boolean
}

const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const ENTER = '\r'

/** Validate an answer for the parsed step. Returns an error or null. */
export function validateScreenAnswer(p: ClaudeScreenQuestion, a: ScreenAnswer): string | null {
  if (p.step === 'review') return a.submit === true ? null : 'the review step can only be submitted'
  if (a.submit) return 'this step is a question, not the review'
  const sel = Array.isArray(a.selected) ? a.selected : []
  if (sel.some((x) => !Number.isInteger(x) || x < 0 || x >= p.options.length)) return 'no such option'
  if (new Set(sel).size !== sel.length) return 'duplicate option'
  if (p.options.length > 8) return 'too many options to select by key'
  const other = a.other !== undefined ? sanitizeOther(a.other) : ''
  if (a.other !== undefined && !other) return 'empty free-text answer'
  if (p.multiSelect) {
    if (other) return "free text on a multi-select question isn't supported remotely"
    if (sel.length === 0) return 'pick at least one option'
  } else if (sel.length + (other ? 1 : 0) !== 1) {
    return 'pick exactly one option'
  }
  return null
}

function squashedTail(s: string): string {
  return s.split('\n').slice(-QUESTION_TAIL_LINES).join('\n').replace(/\s+/g, '')
}

/**
 * Keystrokes for one step, each screen-verified. A step "moved" when the
 * dialog left this exact step (different fingerprint, or closed). Claude's
 * lazy repaint is handled with a Down nudge only where focus doesn't matter
 * (every next step is answered by index digits, Submit included).
 */
export function planScreenSteps(p: ClaudeScreenQuestion, a: ScreenAnswer): AnswerStep[] {
  const same = (s: string) => parseClaudeQuestionScreen(s)?.fingerprint === p.fingerprint
  const gone = (s: string) => !looksLikeQuestionDialog('claude', s)
  if (p.step === 'review') return [{ label: 'submit answers', guard: same, keys: ['1'], expect: gone }]

  const lone = p.tabs.length === 1 && !p.multiSelect // its pick submits the whole dialog
  const advance = lone ? { expect: gone } : { expect: (s: string) => !same(s), nudge: [DOWN] }
  const n = p.options.length

  if (p.multiSelect) {
    const want = new Set(a.selected ?? [])
    const toggles = p.options.map((_, i) => i).filter((i) => want.has(i) !== (p.options[i].ticked === true))
    // ticks often don't repaint, so a toggle only re-checks that the same
    // question is still up; the review step then shows the exact result
    const sameQuestion = (s: string) => {
      const q = parseClaudeQuestionScreen(s)
      return q?.step === 'question' && q.question === p.question && q.multiSelect
    }
    const steps: AnswerStep[] = toggles.map((i, k) => ({
      label: `toggle option ${i + 1}`,
      guard: k === 0 ? same : sameQuestion,
      keys: [String(i + 1)],
      expect: sameQuestion,
    }))
    steps.push({ label: 'next', guard: toggles.length ? sameQuestion : same, keys: [RIGHT], expect: (s) => !sameQuestion(s), nudge: [DOWN] })
    return steps
  }

  if (a.other !== undefined) {
    const text = sanitizeOther(a.other)
    const focused = (s: string) => parseClaudeQuestionScreen(s)?.step === 'question' && squashedTail(s).includes(`❯${n + 1}.`)
    return [
      { label: 'focus "Type something"', guard: same, keys: [String(n + 1)], expect: focused },
      {
        label: 'type free text',
        keys: [text],
        expect: (s) => {
          const q = parseClaudeQuestionScreen(s)
          return q?.step === 'question' && q.question === p.question && q.otherText === text
        },
      },
      { label: 'commit free text', keys: [ENTER], ...advance },
    ]
  }
  const k = (a.selected ?? [])[0]
  return [{ label: `pick option ${k + 1}`, guard: same, keys: [String(k + 1)], ...advance }]
}

/**
 * Bridge entry point for `screen:` answers: the step on screen NOW must be
 * the exact step the card was built from (same fingerprint), else 'stale'
 * and nothing is typed.
 */
export async function executeScreenAnswer(
  backend: Pick<Backend, 'readScreen' | 'sendText'>,
  paneId: string,
  callId: string,
  answer: ScreenAnswer,
  clock: StepClock,
): Promise<AnswerOutcome> {
  const id = parseScreenCallId(callId)
  if (!id) return { status: 'failed', outcome: 'malformed screen card id' }
  if (id.paneId !== paneId) return { status: 'stale', outcome: 'the card belongs to a different pane — nothing was typed' }
  const screen = await backend.readScreen(paneId)
  const p = parseClaudeQuestionScreen(screen)
  if (!p) return { status: 'stale', outcome: 'no question dialog on screen — nothing was typed' }
  if (p.fingerprint !== id.fingerprint) {
    return { status: 'stale', outcome: 'the dialog on screen changed — nothing was typed' }
  }
  const invalid = validateScreenAnswer(p, answer)
  if (invalid) return { status: 'failed', outcome: invalid }
  return runAnswerSteps(backend, paneId, planScreenSteps(p, answer), clock)
}
