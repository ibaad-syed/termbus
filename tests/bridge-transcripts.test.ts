import { describe, expect, it } from 'vitest'
import { linkSessionsToPanes, SYNTHETIC_EPOCH } from '../src/commands/bridge-transcripts.js'

describe('linkSessionsToPanes', () => {
  const s = (id: string, agent: string, cwd: string | undefined, act: number) =>
    ({ sessionId: id, agent: agent as 'claude' | 'codex', cwd, lastActivity: act })
  const p = (id: string, kind: string, cwd: string | null) => ({ paneId: id, kind, cwd })

  it('links by agent kind and cwd prefix', () => {
    const links = linkSessionsToPanes(
      [s('s1', 'claude', '/repo/app', 2), s('s2', 'codex', '/repo/app', 1)],
      [p('pA', 'claude', '/repo/app'), p('pB', 'codex', '/repo/app/sub')],
    )
    expect(links.get('s1')).toBe('pA')
    expect(links.get('s2')).toBe('pB')
  })

  it('ambiguous folder match (two sessions, one unidentified pane) → no link, never a guess', () => {
    const links = linkSessionsToPanes(
      [s('old', 'claude', '/repo', 1), s('new', 'claude', '/repo', 9)],
      [p('pA', 'claude', '/repo')],
    )
    expect(links.size).toBe(0)
  })

  it('the bug: five Claude agents in one folder link EXACTLY by identity, whatever their activity order', () => {
    // real shape from 2026-10-12: all in /Ponder, recency order ≠ pane order
    const sessions = [
      s('dead0dd8', 'claude', '/Ponder', 5),
      s('cb861b18', 'claude', '/Ponder', 4),
      s('abac5693', 'claude', '/Ponder', 3),
      s('329a0dca', 'claude', '/Ponder', 2),
      s('462c74e9', 'claude', '/Ponder', 1),
    ]
    const truth: Record<string, string> = {
      '044D8EAE': '462c74e9',
      A6A14D03: 'abac5693',
      '846B5C00': 'dead0dd8',
      F12ACEC1: 'cb861b18',
      '8CF43021': '329a0dca',
    }
    const panes = Object.entries(truth).map(([pane, sid]) => ({ paneId: pane, kind: 'claude', cwd: '/Ponder', sessionId: sid }))
    const links = linkSessionsToPanes(sessions, panes)
    for (const [pane, sid] of Object.entries(truth)) expect(links.get(sid)).toBe(pane)
  })

  it('one unidentified pane among identified ones: folder fallback only if it is the single candidate', () => {
    const links = linkSessionsToPanes(
      [s('a', 'claude', '/Ponder', 2), s('b', 'claude', '/Ponder', 1)],
      [
        { paneId: 'pA', kind: 'claude', cwd: '/Ponder', sessionId: 'a' },
        { paneId: 'pB', kind: 'claude', cwd: '/Ponder', sessionId: null },
      ],
    )
    expect(links.get('a')).toBe('pA')
    expect(links.get('b')).toBe('pB') // the only loose session and the only unknown pane
  })

  it('two unidentified panes in one folder → neither linked', () => {
    const links = linkSessionsToPanes(
      [s('a', 'claude', '/Ponder', 2)],
      [p('pA', 'claude', '/Ponder'), p('pB', 'claude', '/Ponder')],
    )
    expect(links.size).toBe(0)
  })

  it('no link across agent kinds or unrelated cwds', () => {
    const links = linkSessionsToPanes(
      [s('s1', 'claude', '/repo', 1), s('s2', 'codex', '/elsewhere', 1)],
      [p('pA', 'codex', '/repo'), p('pB', 'claude', '/other')],
    )
    expect(links.size).toBe(0)
  })

  it('sessions without cwd never link', () => {
    const links = linkSessionsToPanes([s('s1', 'claude', undefined, 1)], [p('pA', 'claude', '/repo')])
    expect(links.size).toBe(0)
  })
})

describe('synthetic epoch namespace', () => {
  it('is far outside any real file epoch', () => {
    expect(SYNTHETIC_EPOCH).toBeGreaterThan(100000)
  })
})
