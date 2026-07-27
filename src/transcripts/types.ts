export type TranscriptAgent = 'claude' | 'codex'

export type TranscriptEventKind =
  | 'session_start'
  | 'user_msg'
  | 'assistant_msg'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'turn_done'
  | 'system'

export interface TranscriptTool {
  name: string
  inputPreview?: string
  status?: string
}

/**
 * Normalized transcript event, schema v1.
 *
 * `seq` is the 0-based line number of the source JSONL line the event came
 * from. One source line can emit several events (e.g. a Claude assistant
 * entry with thinking + text + tool_use blocks), so `subSeq` is the 0-based
 * ordinal of the event within its line — (sessionId, epoch, seq, subSeq) is
 * the unique ordering key.
 *
 * Both Claude Code and Codex session files are append-only in practice
 * (Codex compaction appends a `compacted` entry rather than rewriting the
 * file), so seq is monotonically increasing within a session. If a file is
 * ever truncated or rewritten (size shrinks below the tailer's offset), the
 * tailer resets to byte 0 and stamps subsequent events with an incremented
 * `epoch`. `epoch` is always present (0 for a never-truncated file) so it
 * never serializes as undefined/NULL — NULL would break UNIQUE semantics in
 * stores like Postgres.
 */
export interface TranscriptEvent {
  v: 1
  agent: TranscriptAgent
  sessionId: string
  seq: number
  subSeq: number
  epoch: number
  ts: string
  kind: TranscriptEventKind
  text?: string
  tool?: TranscriptTool
  meta?: Record<string, string>
}

export interface SessionInfo {
  agent: TranscriptAgent
  sessionId: string
  path: string
  cwd?: string
  /** file mtime in ms since epoch */
  lastActivity: number
  sizeBytes: number
}

/** Hard cap applied to every `text` field. */
export const MAX_TEXT_CHARS = 16_000
/** Thinking/reasoning blocks are noisier — trimmed harder. */
export const MAX_THINKING_CHARS = 2_000
/** Tool inputs are previews, not payloads. */
export const MAX_TOOL_INPUT_CHARS = 500

export function truncate(s: string, max: number = MAX_TEXT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
