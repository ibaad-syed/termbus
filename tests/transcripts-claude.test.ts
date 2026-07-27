import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeContext, parseClaudeLine } from '../src/transcripts/claude.js'
import { MAX_THINKING_CHARS, MAX_TEXT_CHARS } from '../src/transcripts/types.js'
import type { TranscriptEvent } from '../src/transcripts/types.js'

const fixture = readFileSync(join(__dirname, 'fixtures', 'claude-sample.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)

function parseAll(lines: string[]): TranscriptEvent[] {
  const ctx = createClaudeContext()
  const events: TranscriptEvent[] = []
  lines.forEach((line, i) => {
    const parsed = parseClaudeLine(line, i, ctx)
    if (parsed) events.push(...parsed)
  })
  return events
}

describe('parseClaudeLine on real (redacted) session lines', () => {
  const events = parseAll(fixture)

  it('produces the expected kind sequence', () => {
    expect(events.map((e) => e.kind)).toEqual([
      'user_msg', // "resume"
      'thinking', // plaintext thinking block
      'assistant_msg', 'tool_call', 'tool_result',
      // two assistant entries carry only empty (encrypted) thinking → no events
      'tool_call', 'tool_result',
      'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call',
      'assistant_msg',
      'turn_done',
      'system', 'system', // local_command pair
      'user_msg',
      'assistant_msg', 'assistant_msg',
      'turn_done',
      'user_msg',
      'user_msg', // text-block user entry
      'system', // away_summary
      'user_msg',
    ])
  })

  it('skips all bookkeeping entry types', () => {
    // fixture includes mode, permission-mode, file-history-snapshot,
    // attachment, queue-operation, last-prompt, ai-title — none surface
    const kinds = new Set(events.map((e) => e.kind))
    expect(kinds.has('session_start')).toBe(false)
    expect(events[0].text).toBe('resume')
  })

  it('stamps envelope fields on every event', () => {
    for (const ev of events) {
      expect(ev.v).toBe(1)
      expect(ev.agent).toBe('claude')
      expect(ev.sessionId).toBe('9e47fe5d-0822-4936-a942-bcf7fb708e99')
      expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(ev.epoch).toBe(0)
    }
  })

  it('seq is the source line number and subSeq the within-line ordinal', () => {
    expect(events[0].seq).toBe(3) // "resume" is line 3 of the fixture
    const seqs = events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    // events sharing a seq (multi-block lines) get subSeq 0..n-1, so
    // (seq, subSeq) is unique
    const bySeq = new Map<number, number[]>()
    for (const e of events) bySeq.set(e.seq, [...(bySeq.get(e.seq) ?? []), e.subSeq])
    for (const subs of bySeq.values()) expect(subs).toEqual(subs.map((_, i) => i))
  })

  it('resolves tool_result names from the preceding tool_use id', () => {
    const results = events.filter((e) => e.kind === 'tool_result')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect(r.tool?.name).toBeTruthy()
    const calls = events.filter((e) => e.kind === 'tool_call')
    const callNames = new Set(calls.map((c) => c.tool!.name))
    for (const r of results) expect(callNames.has(r.tool!.name)).toBe(true)
  })

  it('tool_call carries a bounded input preview', () => {
    for (const c of events.filter((e) => e.kind === 'tool_call')) {
      expect(c.tool!.name).toBeTruthy()
      if (c.tool!.inputPreview) expect(c.tool!.inputPreview.length).toBeLessThanOrEqual(501)
    }
  })

  it('turn_done comes from system turn_duration with metadata', () => {
    const dones = events.filter((e) => e.kind === 'turn_done')
    expect(dones).toHaveLength(2)
    expect(Number(dones[0].meta?.durationMs)).toBeGreaterThan(0)
  })
})

describe('parseClaudeLine sidechains', () => {
  const mk = (obj: Record<string, unknown>) =>
    JSON.stringify({
      sessionId: 's1',
      timestamp: '2026-07-22T00:00:00.000Z',
      ...obj,
    })

  it('collapses a sidechain run into one subagent marker', () => {
    const lines = [
      mk({ type: 'user', isSidechain: false, message: { role: 'user', content: 'main' } }),
      mk({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub prompt' } }),
      mk({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub reply' }] } }),
      mk({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'back on main' }] } }),
    ]
    const events = parseAll(lines)
    expect(events.map((e) => e.kind)).toEqual(['user_msg', 'tool_call', 'assistant_msg'])
    expect(events[1].tool).toEqual({ name: 'subagent' })
    expect(events[2].text).toBe('back on main')
  })
})

describe('parseClaudeLine truncation and robustness', () => {
  it('truncates thinking at 2k and text at 16k, with distinct subSeq per sibling', () => {
    const long = 'x'.repeat(40_000)
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-07-22T00:00:00.000Z',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: long },
        { type: 'text', text: long },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ] },
    })
    const [thinking, text, call] = parseClaudeLine(line, 7)!
    expect(thinking.text!.length).toBe(MAX_THINKING_CHARS + 1) // + ellipsis
    expect(text.text!.length).toBe(MAX_TEXT_CHARS + 1)
    // siblings from one source line share seq but never subSeq
    expect([thinking, text, call].map((e) => [e.seq, e.subSeq])).toEqual([[7, 0], [7, 1], [7, 2]])
  })

  it('falls back to the context sessionId, and skips (counting) when none is known', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-22T00:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    })
    const seeded = createClaudeContext('from-filename')
    const [ev] = parseClaudeLine(line, 0, seeded)!
    expect(ev.sessionId).toBe('from-filename')
    expect(seeded.skippedNoSession).toBe(0)

    const bare = createClaudeContext()
    expect(parseClaudeLine(line, 0, bare)).toBeNull()
    expect(bare.skippedNoSession).toBe(1)
  })

  it('returns null for garbage, blanks, and unknown types', () => {
    expect(parseClaudeLine('not json {', 0)).toBeNull()
    expect(parseClaudeLine('', 0)).toBeNull()
    expect(parseClaudeLine('"just a string"', 0)).toBeNull()
    expect(parseClaudeLine(JSON.stringify({ type: 'some-future-type' }), 0)).toBeNull()
  })
})
