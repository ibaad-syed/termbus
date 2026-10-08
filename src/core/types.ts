export interface Pane {
  id: string          // terminal-native session UUID
  label: string       // stable auto-label, e.g. "w1.t2.p1"
  title: string       // session name/title as shown by the terminal
  tty: string         // e.g. "/dev/ttys009"
  isSelf: boolean
  windowIndex: number
  tabIndex: number
  paneIndex: number
}

export interface Backend {
  readonly name: string
  listPanes(): Promise<Pane[]>
  readScreen(paneId: string): Promise<string>
  sendText(paneId: string, text: string, submit: boolean): Promise<void>
  /** Optional: set the terminal's own name/title for a pane. */
  setPaneName?(paneId: string, name: string): Promise<void>
  /** Like listPanes, but null instead of launching a terminal that is not running. */
  listPanesIfRunning?(): Promise<Pane[] | null>
  /** Optional layout creation (used by restore). Each returns the new pane's id. */
  createWindow?(opts?: CreatePaneOptions): Promise<string>
  createTab?(nearPaneId: string, opts?: CreatePaneOptions): Promise<string>
  /** stacked: new pane below (iTerm "split horizontally"); default: beside it */
  splitPane?(paneId: string, opts?: CreatePaneOptions & { stacked?: boolean }): Promise<string>
  /** Optional: per-pane size/profile and window shape, for layout capture. */
  paneGeometry?(): Promise<Map<string, { cols: number; rows: number; windowPx: { w: number; h: number }; profile: string }> | null>
}

export type OccupantKind = 'claude' | 'codex' | 'shell' | 'command' | 'unknown'
export type AgentKind = 'claude' | 'codex'

export interface Occupant {
  kind: OccupantKind
  command: string | null // full foreground command line, null for shell/unknown
}

export interface AskResult {
  kind: 'shell' | 'agent'
  response: string
  exitCode?: number // shell asks only
  screen: string    // final screen capture
  /** set when the ask stopped early because the agent hit a modal prompt */
  status?: 'awaiting-input'
}

export interface CreatePaneOptions {
  /** run this instead of the profile's default shell/command */
  command?: string
  /** profile name; unknown names fall back to the default profile */
  profile?: string
}
