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
