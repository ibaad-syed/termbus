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
