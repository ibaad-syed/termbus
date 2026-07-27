import type { TranscriptEvent } from './types.js'
import { MAX_THINKING_CHARS, MAX_TOOL_INPUT_CHARS, truncate } from './types.js'

/**
 * Claude Code session files: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl,
 * one JSON entry per line, live-appended. Verified against real sessions
 * (Claude Code 2.1.x): entry types seen are user / assistant / system plus
 * bookkeeping (mode, permission-mode, file-history-snapshot, attachment,
 * queue-operation, last-prompt, ai-title), all of which are skipped.
 *
 * Note on sidechains: current Claude Code writes subagent transcripts to a
 * separate `subagents/agent-*.jsonl` directory, so `isSidechain: true` never
 * appears in main session files anymore. The handling here is defensive for
 * older files: sidechain entries are skipped except a single synthetic
 * `tool_call` (name 'subagent') marking where the sidechain began.
 */

/** Bookkeeping entry types that never produce a transcript event. */
const IGNORED_TYPES = new Set([
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'attachment',
  'queue-operation',
  'last-prompt',
  'ai-title',
  'summary',
])

/**
 * Cross-line parser state. tool_use ids are remembered so a later
 * tool_result (which only carries the id) can be labeled with the tool name.
 * `sessionId` (usually the discovery-time filename id) is the fallback for
 * entries that don't carry their own; events are never emitted with an empty
 * sessionId — they are skipped and counted in `skippedNoSession` instead.
 */
export interface ClaudeParseContext {
  sessionId: string
  toolNames: Map<string, string>
  inSidechain: boolean
  skippedNoSession: number
}

export function createClaudeContext(sessionId = ''): ClaudeParseContext {
  return { sessionId, toolNames: new Map(), inSidechain: false, skippedNoSession: 0 }
}

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

/** Flatten a tool_result `content` (string or block array) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ContentBlock => typeof b === 'object' && b !== null)
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function parseClaudeLine(
  line: string,
  seq: number,
  ctx: ClaudeParseContext = createClaudeContext(),
): TranscriptEvent[] | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let entry: any
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null

  const sessionId =
    typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : ctx.sessionId
  const base = {
    v: 1 as const,
    agent: 'claude' as const,
    sessionId,
    seq,
    subSeq: 0,
    epoch: 0,
    ts: typeof entry.timestamp === 'string' ? entry.timestamp : '',
  }

  // Sidechain entries stay out of the main stream; a single marker records
  // that a subagent ran here.
  if (entry.isSidechain === true) {
    if (ctx.inSidechain) return null
    ctx.inSidechain = true
    if (!sessionId) {
      ctx.skippedNoSession++
      return null
    }
    return [{ ...base, kind: 'tool_call', tool: { name: 'subagent' } }]
  }
  if (entry.isSidechain === false) ctx.inSidechain = false

  const type = entry.type
  if (typeof type !== 'string' || IGNORED_TYPES.has(type)) return null

  const events: TranscriptEvent[] = []

  if (type === 'user') {
    const content = entry.message?.content
    if (typeof content === 'string') {
      if (content) events.push({ ...base, kind: 'user_msg', text: truncate(content) })
    } else if (Array.isArray(content)) {
      const texts: string[] = []
      for (const block of content as ContentBlock[]) {
        if (typeof block !== 'object' || block === null) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        } else if (block.type === 'tool_result') {
          const name = block.tool_use_id ? ctx.toolNames.get(block.tool_use_id) : undefined
          const text = toolResultText(block.content)
          events.push({
            ...base,
            kind: 'tool_result',
            ...(text ? { text: truncate(text) } : {}),
            ...(name ? { tool: { name } } : {}),
          })
        }
        // image and other block types carry nothing displayable — skipped
      }
      if (texts.length) events.push({ ...base, kind: 'user_msg', text: truncate(texts.join('\n')) })
    }
  } else if (type === 'assistant') {
    const content = entry.message?.content
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (typeof block !== 'object' || block === null) continue
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          events.push({ ...base, kind: 'assistant_msg', text: truncate(block.text) })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          events.push({ ...base, kind: 'thinking', text: truncate(block.thinking, MAX_THINKING_CHARS) })
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          if (typeof block.id === 'string') ctx.toolNames.set(block.id, block.name)
          let inputPreview: string | undefined
          try {
            inputPreview = truncate(JSON.stringify(block.input) ?? '', MAX_TOOL_INPUT_CHARS)
          } catch {
            inputPreview = undefined
          }
          events.push({
            ...base,
            kind: 'tool_call',
            tool: { name: block.name, ...(inputPreview ? { inputPreview } : {}) },
          })
        }
      }
    }
  } else if (type === 'system') {
    // turn_duration marks the end of an agent turn — the closest thing Claude
    // files have to an explicit turn boundary.
    if (entry.subtype === 'turn_duration') {
      const meta: Record<string, string> = {}
      if (typeof entry.durationMs === 'number') meta.durationMs = String(entry.durationMs)
      if (typeof entry.messageCount === 'number') meta.messageCount = String(entry.messageCount)
      events.push({ ...base, kind: 'turn_done', ...(Object.keys(meta).length ? { meta } : {}) })
    } else if (typeof entry.content === 'string' && entry.content) {
      events.push({ ...base, kind: 'system', text: truncate(entry.content) })
    }
  }

  if (!events.length) return null
  if (!sessionId) {
    ctx.skippedNoSession += events.length
    return null
  }
  // subSeq: emission order within this source line
  return events.map((e, i) => ({ ...e, subSeq: i }))
}
