import type { AgentKind } from '../core/types.js'

/** One agent pane as it looked when a snapshot was taken. */
export interface SavedAgent {
  paneId: string // terminal-native id at snapshot time (dies with the terminal)
  windowIndex: number
  tabIndex: number
  paneIndex: number
  title: string
  kind: AgentKind
  sessionId: string | null // the conversation to resume; null if it could not be determined
  cwd: string | null
  command: string // foreground command line, as ps shows it
}

/** Every pane (agents, shells, dev servers) with its place and shape, so a
 *  tab's split layout can be rebuilt. Not part of a generation's identity:
 *  resizing a pane is not a new state. */
export interface SavedPane {
  windowIndex: number
  tabIndex: number
  paneIndex: number
  cols: number
  rows: number
  windowPx: { w: number; h: number } | null
  profile: string | null
  name: string
  kind: AgentKind | 'shell' | 'other'
  sessionId: string | null // agents only
  cwd: string | null
}

/**
 * A distinct state of the terminal's agent panes. Consecutive identical states
 * share one generation (only lastSeenAt moves). `instance` identifies one run
 * of the terminal app (pid + start time), so "what was open before the
 * restart" is the last generation of the previous instance.
 */
export interface Generation {
  id: number
  instance: string | null
  takenAt: number
  lastSeenAt: number
  agents: SavedAgent[]
  /** absent in snapshots taken before layout capture existed */
  layout?: SavedPane[]
}

export interface SnapshotStore {
  v: 1
  nextId: number
  generations: Generation[]
}
