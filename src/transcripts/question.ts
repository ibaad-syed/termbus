import type { TranscriptAgent, TranscriptQuestionItem } from './types.js'
import { MAX_QUESTION_ITEMS, MAX_QUESTION_OPTIONS, MAX_QUESTION_TEXT_CHARS, truncate } from './types.js'

/** Tool names that put an interactive question dialog on screen. */
export const QUESTION_TOOLS: Record<TranscriptAgent, string> = {
  claude: 'AskUserQuestion',
  codex: 'request_user_input',
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * Normalize a question tool's input ({questions: [...]}) for either agent.
 * Returns null when the shape is unusable (no questions, or a question with
 * no options) — those can't be answered by keystroke from HQ, so no card.
 *
 * Claude: {question, header, multiSelect, options[{label, description, preview?}]}
 *   answers are keyed by question text.
 * Codex:  {id, header, question, options[{label, description}], isOther?, isSecret?}
 *   single-select only; answers are keyed by id.
 */
export function normalizeQuestionItems(agent: TranscriptAgent, input: unknown): TranscriptQuestionItem[] | null {
  if (typeof input !== 'object' || input === null) return null
  const qs = (input as { questions?: unknown }).questions
  if (!Array.isArray(qs) || qs.length === 0 || qs.length > MAX_QUESTION_ITEMS) return null
  const items: TranscriptQuestionItem[] = []
  for (const q of qs) {
    if (typeof q !== 'object' || q === null) return null
    const rec = q as Record<string, unknown>
    const question = str(rec.question)
    if (!question) return null
    if (!Array.isArray(rec.options) || rec.options.length === 0 || rec.options.length > MAX_QUESTION_OPTIONS) return null
    const options = []
    for (const o of rec.options) {
      const label = typeof o === 'object' && o !== null ? str((o as Record<string, unknown>).label) : undefined
      if (!label) return null
      const description = str((o as Record<string, unknown>).description)
      options.push({
        label: truncate(label, MAX_QUESTION_TEXT_CHARS),
        ...(description ? { description: truncate(description, MAX_QUESTION_TEXT_CHARS) } : {}),
      })
    }
    const key = agent === 'codex' ? str(rec.id) : question
    if (!key) return null
    const header = str(rec.header)
    items.push({
      key,
      ...(header ? { header: truncate(header, 60) } : {}),
      question: truncate(question, MAX_QUESTION_TEXT_CHARS),
      multiSelect: agent === 'claude' && rec.multiSelect === true,
      options,
    })
  }
  return items
}

/** Codex output `{"answers":{"<id>":{"answers":["Label","user_note: …"]}}}` → id → text. */
export function parseCodexAnswers(output: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(output) as { answers?: Record<string, { answers?: unknown }> }
    if (!parsed || typeof parsed.answers !== 'object' || parsed.answers === null) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.answers)) {
      const list = Array.isArray(v?.answers) ? v.answers.filter((x): x is string => typeof x === 'string') : []
      out[k] = truncate(list.join(' · '), MAX_QUESTION_TEXT_CHARS)
    }
    return out
  } catch {
    return null
  }
}

/** Claude toolUseResult.answers is already {question text → "A, B"}. */
export function parseClaudeAnswers(toolUseResult: unknown): Record<string, string> | null {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return null
  const answers = (toolUseResult as { answers?: unknown }).answers
  if (typeof answers !== 'object' || answers === null) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === 'string') out[k] = truncate(v, MAX_QUESTION_TEXT_CHARS)
  }
  return out
}
