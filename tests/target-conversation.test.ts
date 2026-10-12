import { describe, expect, it } from 'vitest'
import { linkSessionsToPanes, TranscriptFeeder } from '../src/commands/bridge-transcripts.js'
import { checkTargetSession, NO_TARGET_CONVERSATION, targetSessionGate } from '../src/commands/bridge.js'
import type { SessionInfo } from '../src/transcripts/types.js'

describe('five agents in one folder, across claude / codex / devin', () => {
  // all in /Ponder; activity order deliberately differs from pane order
  const sessions = [
    { sessionId: 'c1', agent: 'claude' as const, cwd: '/Ponder', lastActivity: 5 },
    { sessionId: 'x1', agent: 'codex' as const, cwd: '/Ponder', lastActivity: 4 },
    { sessionId: 'c2', agent: 'claude' as const, cwd: '/Ponder', lastActivity: 3 },
    { sessionId: 'adaptive-hardcover', agent: 'devin' as const, cwd: '/Ponder', lastActivity: 2 },
    { sessionId: 'x2', agent: 'codex' as const, cwd: '/Ponder', lastActivity: 1 },
  ]
  const truth: Record<string, { kind: string; sid: string }> = {
    P1: { kind: 'claude', sid: 'c2' },
    P2: { kind: 'codex', sid: 'x2' },
    P3: { kind: 'devin', sid: 'adaptive-hardcover' },
    P4: { kind: 'claude', sid: 'c1' },
    P5: { kind: 'codex', sid: 'x1' },
  }
  it('every pane links exactly to the conversation its process runs', () => {
    const panes = Object.entries(truth).map(([paneId, t]) => ({ paneId, kind: t.kind, cwd: '/Ponder', sessionId: t.sid }))
    const links = linkSessionsToPanes(sessions, panes)
    expect(links.size).toBe(5)
    for (const [paneId, t] of Object.entries(truth)) expect(links.get(t.sid)).toBe(paneId)
  })
  it('panes whose identity is unreadable are never guessed by folder when it is ambiguous', () => {
    const panes = Object.entries(truth).map(([paneId, t]) => ({ paneId, kind: t.kind, cwd: '/Ponder', sessionId: null }))
    const links = linkSessionsToPanes(sessions, panes)
    // each kind has ≥2 sessions or the devin one is alone: only devin is unambiguous
    expect([...links]).toEqual([['adaptive-hardcover', 'P3']])
  })
  it('the feeder links Devin by its lock\'s tty and never guesses the others by folder', async () => {
    const f = new TranscriptFeeder(async () => new Response('{}'))
    const infos: SessionInfo[] = sessions.map((s) => ({
      ...s,
      path: '/x',
      sizeBytes: 0,
      ...(s.agent === 'devin' ? { tty: 'ttys906' } : {}),
    }))
    // fake ttys: no process can be read on them, so no pane is identified
    const panes = Object.keys(truth).map((id, i) => ({
      id,
      label: `w1.t1.p${i + 1}`,
      title: id,
      tty: `/dev/ttys90${i + 3}`,
      isSelf: false,
      windowIndex: 1,
      tabIndex: 1,
      paneIndex: i + 1,
    }))
    await f.refreshLinks(panes, infos)
    expect(f.linkedPane('adaptive-hardcover')).toBe('P4') // P4 sits on ttys906
    for (const id of ['c1', 'c2', 'x1', 'x2']) expect(f.linkedPane(id)).toBeUndefined()
  })
})

describe('HQ actions must name the conversation they are for', () => {
  const identified = async () => 'c1'
  const unidentified = async () => null

  it('missing sessionId on a pane with an identifiable conversation → refused, nothing typed', async () => {
    for (const kind of ['send', 'approve', 'reject', 'answer'] as const) {
      expect(await targetSessionGate({ kind }, '/dev/ttys001', identified)).toEqual({ status: 'stale', outcome: NO_TARGET_CONVERSATION })
      expect(await targetSessionGate({ kind, sessionId: null }, '/dev/ttys001', identified)).toEqual({ status: 'stale', outcome: NO_TARGET_CONVERSATION })
    }
    expect(NO_TARGET_CONVERSATION).toBe('message has no target conversation — not sent')
  })
  it('missing sessionId on a pane with no identifiable conversation (new pane, screen-only agent) → allowed', async () => {
    for (const kind of ['send', 'approve', 'reject', 'answer'] as const) {
      expect(await targetSessionGate({ kind }, '/dev/ttys001', unidentified)).toBeNull()
    }
  })
  it('a named conversation must match exactly', async () => {
    expect(await targetSessionGate({ kind: 'send', sessionId: 'c1' }, '/dev/ttys001', identified)).toBeNull()
    expect(await targetSessionGate({ kind: 'send', sessionId: 'c2' }, '/dev/ttys001', identified)).toMatchObject({ status: 'stale', outcome: expect.stringMatching(/different conversation/) })
    expect(await targetSessionGate({ kind: 'send', sessionId: 'c1' }, '/dev/ttys001', unidentified)).toMatchObject({ status: 'stale', outcome: expect.stringMatching(/can't confirm/) })
  })
  it('works for Devin session ids too', async () => {
    expect(await checkTargetSession('/dev/ttys006', 'adaptive-hardcover', async () => 'adaptive-hardcover')).toBeNull()
    expect(await checkTargetSession('/dev/ttys006', undefined, async () => 'adaptive-hardcover')).toBe(NO_TARGET_CONVERSATION)
  })
  it('actions that do not type into a conversation are not gated', async () => {
    for (const kind of ['rename', 'mark', 'spawn', 'exec', 'org'] as const) {
      expect(await targetSessionGate({ kind }, '/dev/ttys001', identified)).toBeNull()
    }
  })
})
