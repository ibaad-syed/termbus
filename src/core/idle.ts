import type { AgentKind } from './types.js'

/**
 * Data-driven busy markers per agent TUI. These match transient "working"
 * chrome that disappears when the agent is waiting for input. New agent
 * versions = add a regex here + a fixture in tests/idle.test.ts.
 */
const BUSY_MARKERS: Record<AgentKind, RegExp[]> = {
  claude: [/esc to interrupt/i, /ctrl\+c to stop/i, /[✻✽✶✢]\s+\S+ing…/],
  codex: [/esc to interrupt/i, /▌\s*Working/i],
}

// Busy chrome lives at the bottom of the screen. Scanning the whole screen
// makes an idle agent whose transcript merely *mentions* a busy phrase read
// as permanently busy, so only the footer is inspected.
const FOOTER_LINES = 15

export function looksBusy(kind: AgentKind, screen: string): boolean {
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n')
  return BUSY_MARKERS[kind].some((re) => re.test(tail))
}

/**
 * Markers for modal dialogs that block the agent until a human (or another
 * agent) answers: permission prompts, trust-folder dialogs, pickers. Same
 * extension contract as BUSY_MARKERS: new agent/dialog = a regex + a fixture.
 */
const PROMPT_MARKERS: Record<AgentKind, RegExp[]> = {
  claude: [/[❯›]\s*\d+\.\s/, /enter to confirm/i, /do you want to (proceed|make|create|allow)/i],
  // codex renders its selector as › (single right angle), not ❯ — seen live on
  // its trust-directory dialog, which also says "Press enter to continue"
  codex: [/[❯›]\s*\d+\.\s/, /press enter to (confirm|continue)/i, /would you like to (make|proceed|run|approve)/i, /do you trust/i],
}

export type AgentScreenState = 'idle' | 'busy' | 'awaiting-input'

/**
 * Busy wins over prompt markers: while streaming, a transcript can echo
 * dialog-like text, but real dialogs only appear when the agent has stopped.
 */
export function agentScreenState(kind: AgentKind, screen: string): AgentScreenState {
  if (looksBusy(kind, screen)) return 'busy'
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n')
  if (PROMPT_MARKERS[kind].some((re) => re.test(tail))) return 'awaiting-input'
  return 'idle'
}
