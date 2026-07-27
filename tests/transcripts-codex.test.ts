import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCodexContext, parseCodexLine } from '../src/transcripts/codex.js'
import type { TranscriptEvent } from '../src/transcripts/types.js'

const fixture = readFileSync(join(__dirname, 'fixtures', 'codex-sample.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)

function parseAll(lines: string[]): TranscriptEvent[] {
  const ctx = createCodexContext()
  const events: TranscriptEvent[] = []
  lines.forEach((line, i) => {
    const parsed = parseCodexLine(line, i, ctx)
    if (parsed) events.push(...parsed)
  })
  return events
}

describe('parseCodexLine on real (redacted) rollout lines', () => {
  const events = parseAll(fixture)

  it('produces the expected kind sequence', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'session_start',
      'user_msg', 'assistant_msg', 'tool_call', 'tool_result', 'assistant_msg', 'turn_done',
      'user_msg', 'assistant_msg', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
      'assistant_msg', 'turn_done',
      'user_msg',
      'turn_done', // turn_aborted
      'user_msg',
      'tool_call', 'tool_result', 'tool_call', 'tool_call', 'tool_result',
      'system', // inter-agent message
      'system', // compacted
    ])
  })

  it('session_start carries cwd and cli_version, and seeds the session id', () => {
    const start = events[0]
    expect(start.meta?.cwd).toBe('/Users/u/project')
    expect(start.meta?.cli_version).toBeTruthy()
    for (const ev of events) {
      expect(ev.sessionId).toBe('019f8a88-7746-78f1-b597-eaeed91a910b')
      expect(ev.agent).toBe('codex')
      expect(ev.v).toBe(1)
      expect(ev.epoch).toBe(0)
      expect(ev.subSeq).toBe(0) // codex entries map 1:1 to events
    }
  })

  it('does not double-emit messages that appear as both event_msg and response_item', () => {
    // fixture contains event_msg user_message / agent_message copies of the
    // same texts — each message must surface exactly once
    const texts = events.filter((e) => e.kind === 'assistant_msg').map((e) => e.text)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('skips injected user-role context (permissions, environment, AGENTS.md)', () => {
    for (const ev of events.filter((e) => e.kind === 'user_msg')) {
      expect(ev.text!.startsWith('<')).toBe(false)
      expect(ev.text!.startsWith('# AGENTS.md')).toBe(false)
    }
  })

  it('labels tool_result events via call_id → name', () => {
    const results = events.filter((e) => e.kind === 'tool_result')
    expect(results.length).toBe(5)
    for (const r of results) expect(['exec', 'wait']).toContain(r.tool?.name)
    expect(results.some((r) => r.text)).toBe(true)
  })

  it('marks the aborted turn', () => {
    const dones = events.filter((e) => e.kind === 'turn_done')
    expect(dones).toHaveLength(3)
    expect(dones[2].meta?.aborted).toBe('true')
  })

  it('notes compaction as a system event', () => {
    const systems = events.filter((e) => e.kind === 'system')
    expect(systems.at(-1)?.text).toBe('context compacted')
  })

  it('drops encrypted-only reasoning (no plaintext summary)', () => {
    // fixture reasoning entries have empty summaries — nothing displayable
    expect(events.some((e) => e.kind === 'thinking')).toBe(false)
  })
})

describe('parseCodexLine synthetic cases', () => {
  it('emits thinking when a reasoning summary has plaintext', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-22T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning the change' }] },
    })
    const [ev] = parseCodexLine(line, 0, createCodexContext('s'))!
    expect(ev.kind).toBe('thinking')
    expect(ev.text).toBe('planning the change')
  })

  it('returns null for garbage and payload-less lines', () => {
    expect(parseCodexLine('{{{', 0)).toBeNull()
    expect(parseCodexLine('', 0)).toBeNull()
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg' }), 0)).toBeNull()
  })

  it('never emits an event with an empty sessionId — skips and counts', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-22T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    })
    // no discovery id and no session_meta seen yet
    const bare = createCodexContext()
    expect(parseCodexLine(line, 0, bare)).toBeNull()
    expect(bare.skippedNoSession).toBe(1)
    // seeded from discovery (e.g. the filename uuid) it emits normally
    const seeded = createCodexContext('from-filename')
    const [ev] = parseCodexLine(line, 0, seeded)!
    expect(ev.sessionId).toBe('from-filename')
    expect(seeded.skippedNoSession).toBe(0)
  })
})
