import { inferSplitTree, pruneTree, type SplitTree } from './layout.js'
import type { SavedAgent, SavedPane } from './types.js'

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

export interface LeafSpec {
  agent: SavedAgent | null // null: a plain shell reopened in its directory
  cwd: string
  profile: string | null
}

/**
 * The layout to rebuild for one tab: the split tree over that tab's saved
 * panes, keeping the agents being restored plus the shells/dev-server panes
 * beside them (reopened as shells in their directory — commands are not
 * re-run). Agents not being restored (still running, unknown) drop out and
 * their splits collapse. Without saved sizes: everything side by side.
 */
export function tabLayout(
  layout: SavedPane[] | undefined,
  restore: SavedAgent[],
): { tree: SplitTree; leaves: Map<number, LeafSpec> } {
  const leaves = new Map<number, LeafSpec>()
  const { windowIndex: w, tabIndex: t } = restore[0]
  const panes = (layout ?? [])
    .filter((p) => p.windowIndex === w && p.tabIndex === t)
    .sort((a, b) => a.paneIndex - b.paneIndex)
  const bySession = new Map(restore.map((a) => [a.sessionId, a]))
  const placed = new Set<SavedAgent>()
  panes.forEach((p, i) => {
    const agent = p.sessionId ? bySession.get(p.sessionId) : undefined
    if (agent) {
      leaves.set(i, { agent, cwd: agent.cwd!, profile: p.profile })
      placed.add(agent)
    } else if ((p.kind === 'shell' || p.kind === 'other') && p.cwd) {
      leaves.set(i, { agent: null, cwd: p.cwd, profile: p.profile })
    }
  })
  const sized = panes.length > 0 && panes.every((p) => p.cols > 0 && p.rows > 0)
  let tree: SplitTree | null = null
  if (placed.size > 0 && sized) {
    const full = inferSplitTree(panes, panes[0].windowPx ?? undefined)
    tree = full ? pruneTree(full, new Set(leaves.keys())) : null
  }
  if (!tree) {
    // no usable layout: the agents alone, side by side
    leaves.clear()
    placed.clear()
  }
  // agents the layout does not know about go to the right, side by side
  let next = Math.max(panes.length, ...leaves.keys(), -1) + 1
  for (const a of restore) {
    if (placed.has(a)) continue
    leaves.set(next, { agent: a, cwd: a.cwd!, profile: null })
    tree = tree ? { dir: 'v', a: tree, b: { leaf: next } } : { leaf: next }
    next++
  }
  return { tree: tree!, leaves }
}

export function describeTree(tree: SplitTree, label: (leaf: number) => string): string {
  if ('leaf' in tree) return label(tree.leaf)
  const a = describeTree(tree.a, label)
  const b = describeTree(tree.b, label)
  return `[${a} ${tree.dir === 'v' ? '|' : '/'} ${b}]`
}
