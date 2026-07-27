import { open, stat } from 'node:fs/promises'
import type { SessionInfo, TranscriptEvent } from './types.js'
import { createClaudeContext, parseClaudeLine, type ClaudeParseContext } from './claude.js'
import { createCodexContext, parseCodexLine, type CodexParseContext } from './codex.js'

/**
 * Persistable tailer position. `offset` always points at the start of a line
 * (bytes past the last complete newline are never consumed), so a tailer
 * restored from this state resumes exactly where the previous one stopped —
 * no partial-line buffer needs to survive the restart.
 */
export interface TailerState {
  offset: number
  epoch: number
  lineNo: number
}

/**
 * Poll-based incremental reader for one session file. Each poll() reads the
 * bytes appended since the previous poll and parses complete lines with the
 * right adapter. A trailing partial line is left unconsumed (offset does not
 * advance past it) and is re-read on the next poll — this keeps multi-byte
 * characters intact and makes getState() fully resumable.
 *
 * No fs.watch — the caller decides the cadence.
 *
 * Truncation: session files are append-only in practice, but if the file
 * shrinks below the consumed offset the tailer restarts from byte 0, resets
 * seq and parser state, and increments epoch — from the RESTORED value when
 * the tailer was created with `initialState`, so epochs never collide with a
 * prior process generation as long as the caller persists getState().
 */
export class SessionTailer {
  private offset: number
  private epoch: number
  private lineNo: number
  private claudeCtx: ClaudeParseContext
  private codexCtx: CodexParseContext

  constructor(
    readonly info: SessionInfo,
    opts: { initialState?: TailerState } = {},
  ) {
    this.offset = opts.initialState?.offset ?? 0
    this.epoch = opts.initialState?.epoch ?? 0
    this.lineNo = opts.initialState?.lineNo ?? 0
    this.claudeCtx = createClaudeContext(info.sessionId)
    this.codexCtx = createCodexContext(info.sessionId)
  }

  /** Current position, safe to persist and pass back as `initialState`. */
  getState(): TailerState {
    return { offset: this.offset, epoch: this.epoch, lineNo: this.lineNo }
  }

  private parse(line: string, seq: number): TranscriptEvent[] | null {
    return this.info.agent === 'claude'
      ? parseClaudeLine(line, seq, this.claudeCtx)
      : parseCodexLine(line, seq, this.codexCtx)
  }

  async poll(): Promise<TranscriptEvent[]> {
    let size: number
    try {
      size = (await stat(this.info.path)).size
    } catch {
      return [] // file gone (session cleaned up) — nothing to report
    }

    if (size < this.offset) {
      // Truncated or rewritten: start over under a new epoch (incremented
      // from the restored value, never reset).
      this.offset = 0
      this.lineNo = 0
      this.claudeCtx = createClaudeContext(this.info.sessionId)
      this.codexCtx = createCodexContext(this.info.sessionId)
      this.epoch++
    }
    if (size <= this.offset) return []

    const toRead = size - this.offset
    const buf = Buffer.alloc(toRead)
    let bytesRead: number
    const fh = await open(this.info.path, 'r')
    try {
      ;({ bytesRead } = await fh.read(buf, 0, toRead, this.offset))
    } finally {
      await fh.close()
    }
    if (bytesRead <= 0) return []

    // Consume only through the last complete line; a trailing partial line
    // stays on disk for the next poll.
    const lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (lastNl === -1) return []
    let data = buf.subarray(0, lastNl + 1)
    this.offset += lastNl + 1

    const events: TranscriptEvent[] = []
    for (;;) {
      const nl = data.indexOf(0x0a)
      if (nl === -1) break
      const line = data.toString('utf8', 0, nl)
      data = data.subarray(nl + 1)
      const seq = this.lineNo++
      const parsed = this.parse(line, seq)
      if (parsed) {
        for (const ev of parsed) events.push({ ...ev, epoch: this.epoch })
      }
    }
    return events
  }
}
