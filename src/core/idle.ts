import { agentDef, type ScreenDef } from './agents.js'
import type { AgentKind } from './types.js'

/**
 * Screen markers live in the agent registry (src/core/agents.ts): busy chrome
 * is transient "working" UI that disappears when the agent waits for input.
 * New agent versions = edit a regex there + a fixture in tests/idle.test.ts.
 */
const NO_MARKERS: ScreenDef = { busy: [], prompt: [] }
const screenOf = (kind: AgentKind): ScreenDef => agentDef(kind)?.screen ?? NO_MARKERS

// Busy chrome lives at the bottom of the screen. Scanning the whole screen
// makes an idle agent whose transcript merely *mentions* a busy phrase read
// as permanently busy, so only the footer is inspected.
const FOOTER_LINES = 15

export function looksBusy(kind: AgentKind, screen: string): boolean {
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n')
  return screenOf(kind).busy.some((re) => re.test(tail))
}

// Modal dialogs that block the agent until a human (or another agent)
// answers — permission prompts, trust-folder dialogs, pickers — are each
// registry entry's `screen.prompt` markers. Same contract: a regex + a fixture.

export type AgentScreenState = 'idle' | 'busy' | 'awaiting-input'

// Interactive question dialogs (Claude AskUserQuestion, Codex
// request_user_input) are `screen.question`. Codex's footer carries "esc to
// interrupt", which is a busy marker, so these win over busy: the dialog only
// renders while the agent is blocked on the user. Agents without one never
// match.

/**
 * Index of the AskUserQuestion tab bar (`←  ☐ Color  ☐ Toppings  ✔ Submit  →`,
 * or ` ☐ Fruit` for a lone question) in `lines`, or -1. TodoWrite renders the
 * same ☐/☒ boxes, so a candidate must sit at the left edge (todo items hang
 * under `⎿`, indented), and either carry `✔ Submit` or sit directly under the
 * dialog's top rule — every captured dialog has the rule right above its bar.
 */
export function findClaudeTabBar(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!/^\s?(←\s+)?[☐☒]\s/.test(l)) continue
    if (/✔\s*Submit/.test(l) || (i > 0 && /^\s*─{8,}\s*$/.test(lines[i - 1]))) return i
  }
  return -1
}

export function looksLikeQuestionDialog(kind: AgentKind, screen: string): boolean {
  const lines = screen.split('\n')
  const tail = lines.slice(-QUESTION_TAIL_LINES).join('\n')
  // the key-hint footer must be the dialog's bottom edge, not transcript text
  // (joined with spaces, whitespace collapsed: in a narrow pane the footer wraps)
  const lastLines = lines.filter((l) => l.trim()).slice(-4).join(' ').replace(/\s+/g, ' ')
  const m = screenOf(kind).question
  if (!m) return false
  const body = kind === 'claude' ? findClaudeTabBar(lines.slice(-QUESTION_TAIL_LINES)) >= 0 : m.body.test(tail)
  if (m.footer.test(lastLines) && body) return true
  // Claude's review tab has no key-hint footer (seen live): it ends with the
  // "1. Submit answers / 2. Cancel" choice under "Ready to submit your answers?"
  return (
    kind === 'claude' &&
    /Ready to submit your answers\? .*1\. Submit answers .*2\. Cancel\s*$/.test(lastLines) &&
    /Review your answers/.test(tail) &&
    findClaudeTabBar(lines.slice(-QUESTION_TAIL_LINES)) >= 0
  )
}

/** Question dialogs are taller than permission prompts (options + descriptions). */
export const QUESTION_TAIL_LINES = 40

/** Idle chrome is matched against the last non-empty lines (trailing blanks
 *  and right padding dropped), so its regexes can anchor on `$`. */
const IDLE_LINES = 14

const lastLines = (screen: string) =>
  screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .slice(-IDLE_LINES)
    .join('\n')

export function looksIdle(kind: AgentKind, screen: string): boolean {
  const idle = screenOf(kind).idle
  if (!idle) return true
  return idle.some((re) => re.test(lastLines(screen)))
}

/**
 * Messages typed in from HQ (remote, unattended) get a stricter gate for
 * agents with `screen.remoteReady`: the pane must read idle AND show that
 * chrome. Returns the refusal, or null when it's fine to type.
 */
export function remoteSendRefusal(kind: AgentKind, screen: string): string | null {
  const gate = screenOf(kind).remoteReady
  if (!gate) return null
  return agentScreenState(kind, screen) === 'idle' && gate.pattern.test(lastLines(screen)) ? null : gate.refusal
}

/**
 * Busy wins over prompt markers: while streaming, a transcript can echo
 * dialog-like text, but real dialogs only appear when the agent has stopped.
 * Agents with positive idle markers read as busy on any screen that matches
 * none of busy, prompt or idle — an unrecognised screen is never "idle".
 */
export function agentScreenState(kind: AgentKind, screen: string): AgentScreenState {
  if (looksLikeQuestionDialog(kind, screen)) return 'awaiting-input'
  if (looksBusy(kind, screen)) return 'busy'
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n')
  if (screenOf(kind).prompt.some((re) => re.test(tail))) return 'awaiting-input'
  return looksIdle(kind, screen) ? 'idle' : 'busy'
}
