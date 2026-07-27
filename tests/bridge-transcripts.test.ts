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

  it('one pane never serves two sessions; most recent session wins', () => {
    const links = linkSessionsToPanes(
      [s('old', 'claude', '/repo', 1), s('new', 'claude', '/repo', 9)],
      [p('pA', 'claude', '/repo')],
    )
    expect(links.get('new')).toBe('pA')
    expect(links.has('old')).toBe(false)
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
