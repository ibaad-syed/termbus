import type { AgentKind } from './types.js'

/**
 * Data-driven busy markers per agent TUI. These match transient "working"
 * chrome that disappears when the agent is waiting for input. New agent
 * versions = add a regex here + a fixture in tests/idle.test.ts.
 */
const BUSY_MARKERS: Record<AgentKind, RegExp[]> = {
  claude: [/esc to interrupt/i, /ctrl\+c to stop/i, /✻\s+\S+ing…/],
  codex: [/esc to interrupt/i, /▌\s*Working/i],
}

export function looksBusy(kind: AgentKind, screen: string): boolean {
  return BUSY_MARKERS[kind].some((re) => re.test(screen))
}
