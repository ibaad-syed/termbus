import type { SavedAgent } from './types.js'

export interface RestorePlan {
  /** window → tab → panes, in the original order */
  windows: SavedAgent[][][]
  skipped: Array<{ agent: SavedAgent; reason: string }>
}

/**
 * `uncertain`: running agents whose conversation could not be identified.
 * Any saved agent they might be (same kind, same directory — or any directory
 * when theirs is unknown) is skipped: a missed restore is recoverable, a
 * duplicate conversation is not.
 */
export function planRestore(
  gen: { agents: SavedAgent[] },
  liveSessionIds: Set<string>,
  uncertain: Array<{ kind: string; cwd: string | null }> = [],
): RestorePlan {
  const maybeLive = (a: SavedAgent) => uncertain.some((u) => u.kind === a.kind && (u.cwd === null || u.cwd === a.cwd))
  const skipped: RestorePlan['skipped'] = []
  const seen = new Set<string>()
  const keep: SavedAgent[] = []
  for (const a of gen.agents) {
    if (!a.sessionId) skipped.push({ agent: a, reason: 'session id unknown' })
    else if (!a.cwd) skipped.push({ agent: a, reason: 'working directory unknown' })
    else if (liveSessionIds.has(a.sessionId)) skipped.push({ agent: a, reason: 'already running' })
    else if (maybeLive(a)) skipped.push({ agent: a, reason: 'possibly running (an agent there could not be identified)' })
    else if (!seen.has(a.sessionId)) {
      seen.add(a.sessionId)
      keep.push(a)
    }
  }
  keep.sort((x, y) => x.windowIndex - y.windowIndex || x.tabIndex - y.tabIndex || x.paneIndex - y.paneIndex)
  const windows: SavedAgent[][][] = []
  let w = -1
  let t = -1
  for (const a of keep) {
    if (a.windowIndex !== w) {
      windows.push([])
      w = a.windowIndex
      t = -1
    }
    const win = windows[windows.length - 1]
    if (a.tabIndex !== t) {
      win.push([])
      t = a.tabIndex
    }
    win[win.length - 1].push(a)
  }
  return { windows, skipped }
}
