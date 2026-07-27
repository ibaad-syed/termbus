import type { TranscriptEvent } from './types.js'
import { MAX_THINKING_CHARS, MAX_TOOL_INPUT_CHARS, truncate } from './types.js'

/**
 * Codex session files: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
 * Verified against real rollouts (codex-tui 0.144.x). Beyond the documented
 * types, `response_item` payloads also include `reasoning` (encrypted, with
 * an optional plaintext summary), `function_call` / `function_call_output`,
 * `custom_tool_call` / `custom_tool_call_output`, and inter-agent
 * `agent_message` entries.
 *
 * Deduplication: every assistant message appears BOTH as an
 * `event_msg{agent_message}` and a `response_item{message role=assistant}`
 * (counts match 1:1 in real files), and likewise user messages appear as
 * `event_msg{user_message}` and `response_item{message role=user}`. Only the
 * response_item form is emitted; the event_msg copies are ignored.
 */

/** Cross-line parser state: session id (seeded from discovery, refined by
 *  session_meta — the only entry that carries it) and call_id → tool name so
 *  outputs can be labeled. Events are never emitted with an empty sessionId —
 *  they are skipped and counted in `skippedNoSession` instead. */
export interface CodexParseContext {
  sessionId: string
  callNames: Map<string, string>
  skippedNoSession: number
}

export function createCodexContext(sessionId = ''): CodexParseContext {
  return { sessionId, callNames: new Map(), skippedNoSession: 0 }
}

/**
 * Codex injects framework context as user-role messages (permissions text,
 * environment_context, AGENTS.md contents). These are not things a person
 * typed, so they are excluded from the user_msg stream.
 */
function isInjectedUserText(text: string): boolean {
  return text.startsWith('<') || text.startsWith('# AGENTS.md')
}

/** Flatten a content array of {type: input_text|output_text|text, text} blocks. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { text?: unknown } => typeof b === 'object' && b !== null)
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function parseCodexLine(
  line: string,
  seq: number,
  ctx: CodexParseContext = createCodexContext(),
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

  const type = entry.type
  const payload = entry.payload
  if (typeof type !== 'string' || typeof payload !== 'object' || payload === null) return null

  if (type === 'session_meta') {
    const id = payload.session_id ?? payload.id
    if (typeof id === 'string') ctx.sessionId = id
  }

  const base = {
    v: 1 as const,
    agent: 'codex' as const,
    sessionId: ctx.sessionId,
    seq,
    subSeq: 0,
    epoch: 0,
    ts: typeof entry.timestamp === 'string' ? entry.timestamp : '',
  }

  const events = mapEntry(type, payload, base, ctx)
  if (!events || !events.length) return null
  if (!ctx.sessionId) {
    // No id from discovery and no session_meta seen yet — an event with an
    // empty sessionId would corrupt the store's keying, so skip and count.
    ctx.skippedNoSession += events.length
    return null
  }
  // subSeq: emission order within this source line (Codex entries currently
  // map 1:1, so it is always 0 — stamped for schema uniformity)
  return events.map((e, i) => ({ ...e, subSeq: i }))
}

function mapEntry(
  type: string,
  payload: any,
  base: Omit<TranscriptEvent, 'kind'>,
  ctx: CodexParseContext,
): TranscriptEvent[] | null {
  if (type === 'session_meta') {
    const meta: Record<string, string> = {}
    if (typeof payload.cwd === 'string') meta.cwd = payload.cwd
    if (typeof payload.cli_version === 'string') meta.cli_version = payload.cli_version
    if (typeof payload.originator === 'string') meta.originator = payload.originator
    return [{ ...base, kind: 'session_start', ...(Object.keys(meta).length ? { meta } : {}) }]
  }

  if (type === 'compacted') {
    // Compaction is appended, never rewritten in place — noted as a system
    // event so consumers know earlier context was summarized away.
    return [{ ...base, kind: 'system', text: 'context compacted' }]
  }

  if (type === 'response_item') {
    const pt = payload.type
    if (pt === 'message') {
      const role = payload.role
      const text = blockText(payload.content)
      if (!text) return null
      if (role === 'user') {
        if (isInjectedUserText(text)) return null
        return [{ ...base, kind: 'user_msg', text: truncate(text) }]
      }
      if (role === 'assistant') {
        return [{ ...base, kind: 'assistant_msg', text: truncate(text) }]
      }
      return null // developer role: injected instructions, not conversation
    }
    if (pt === 'reasoning') {
      // Reasoning bodies are encrypted; only the plaintext summary (when
      // present) is displayable.
      const summary = blockText(payload.summary)
      if (!summary) return null
      return [{ ...base, kind: 'thinking', text: truncate(summary, MAX_THINKING_CHARS) }]
    }
    if (pt === 'function_call' || pt === 'custom_tool_call') {
      const name = typeof payload.name === 'string' ? payload.name : 'unknown'
      if (typeof payload.call_id === 'string') ctx.callNames.set(payload.call_id, name)
      const rawInput = pt === 'function_call' ? payload.arguments : payload.input
      const inputPreview = typeof rawInput === 'string' ? truncate(rawInput, MAX_TOOL_INPUT_CHARS) : undefined
      return [{ ...base, kind: 'tool_call', tool: { name, ...(inputPreview ? { inputPreview } : {}) } }]
    }
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      const name = typeof payload.call_id === 'string' ? ctx.callNames.get(payload.call_id) : undefined
      const text = blockText(payload.output)
      return [{
        ...base,
        kind: 'tool_result',
        ...(text ? { text: truncate(text) } : {}),
        ...(name ? { tool: { name } } : {}),
      }]
    }
    if (pt === 'agent_message') {
      // Inter-agent mail (multi-agent runs). Body is mostly encrypted; only
      // the plaintext header is surfaced.
      const meta: Record<string, string> = {}
      if (typeof payload.author === 'string') meta.author = payload.author
      if (typeof payload.recipient === 'string') meta.recipient = payload.recipient
      const text = blockText(payload.content)
      return [{
        ...base,
        kind: 'system',
        text: truncate(text || 'inter-agent message'),
        ...(Object.keys(meta).length ? { meta } : {}),
      }]
    }
    return null
  }

  if (type === 'event_msg') {
    const pt = payload.type
    if (pt === 'task_complete') {
      const meta: Record<string, string> = {}
      if (typeof payload.turn_id === 'string') meta.turnId = payload.turn_id
      if (typeof payload.duration_ms === 'number') meta.durationMs = String(payload.duration_ms)
      return [{ ...base, kind: 'turn_done', ...(Object.keys(meta).length ? { meta } : {}) }]
    }
    if (pt === 'turn_aborted') {
      return [{ ...base, kind: 'turn_done', meta: { aborted: 'true' } }]
    }
    // task_started is redundant with the user_msg that opens the turn;
    // user_message / agent_message duplicate response_item entries;
    // token_count, patch_apply_end, context_compacted (the `compacted` entry
    // covers it), etc. are bookkeeping.
    return null
  }

  // world_state, turn_context, inter_agent_communication_metadata: bookkeeping
  return null
}
