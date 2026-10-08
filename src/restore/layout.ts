/**
 * Reconstructs a tab's split layout from what iTerm2's AppleScript exposes:
 * each pane's size in cells, in the tab's pane order (a depth-first walk of
 * the split tree). Every binary split tree over that order is scored by how
 * well the pane sizes fit together (side-by-side panes share a height,
 * stacked panes share a width); the window's pixel aspect breaks ties.
 */

export type SplitTree =
  | { leaf: number } // index into the tab's pane list
  | { dir: 'v' | 'h'; a: SplitTree; b: SplitTree } // v = side by side (iTerm "split vertically"), h = stacked

interface Cand {
  tree: SplitTree
  w: number
  h: number
  err: number
}

/** Rough cell width / cell height of a terminal font, for the aspect tie-break. */
const CELL_ASPECT = 0.42
const MAX_PANES = 8 // beyond this, enumeration gets slow; caller falls back

export function inferSplitTree(
  panes: Array<{ cols: number; rows: number }>,
  windowPx?: { w: number; h: number },
): SplitTree | null {
  const n = panes.length
  if (n === 0 || n > MAX_PANES) return null
  if (n === 1) return { leaf: 0 }
  const memo = new Map<string, Cand[]>()
  const all = (i: number, j: number): Cand[] => {
    const key = `${i}:${j}`
    const hit = memo.get(key)
    if (hit) return hit
    const out: Cand[] = []
    if (i === j) out.push({ tree: { leaf: i }, w: panes[i].cols, h: panes[i].rows, err: 0 })
    for (let k = i; k < j; k++) {
      for (const a of all(i, k)) {
        for (const b of all(k + 1, j)) {
          out.push({ tree: { dir: 'v', a: a.tree, b: b.tree }, w: a.w + b.w + 1, h: Math.max(a.h, b.h), err: a.err + b.err + Math.abs(a.h - b.h) })
          out.push({ tree: { dir: 'h', a: a.tree, b: b.tree }, w: Math.max(a.w, b.w), h: a.h + b.h + 1, err: a.err + b.err + Math.abs(a.w - b.w) })
        }
      }
    }
    // keep the candidate list small: best few per (w,h) shape
    out.sort((x, y) => x.err - y.err)
    const pruned = out.slice(0, 64)
    memo.set(key, pruned)
    return pruned
  }
  const cands = all(0, n - 1)
  const best = cands[0].err
  const tied = cands.filter((c) => c.err <= best + 2)
  if (!windowPx || tied.length === 1) return tied[0].tree
  const target = windowPx.w / windowPx.h
  const aspectOff = (c: Cand) => Math.abs(Math.log((c.w * CELL_ASPECT) / c.h / target))
  return tied.reduce((x, y) => (aspectOff(y) < aspectOff(x) ? y : x)).tree
}

/** Drop leaves not in `keep`; a split losing one side collapses into the other. */
export function pruneTree(tree: SplitTree, keep: Set<number>): SplitTree | null {
  if ('leaf' in tree) return keep.has(tree.leaf) ? tree : null
  const a = pruneTree(tree.a, keep)
  const b = pruneTree(tree.b, keep)
  if (a && b) return { dir: tree.dir, a, b }
  return a ?? b
}

export function firstLeaf(tree: SplitTree): number {
  return 'leaf' in tree ? tree.leaf : firstLeaf(tree.a)
}

/** Fallback when sizes are unknown: everything side by side, in order. */
export function sideBySide(indices: number[]): SplitTree | null {
  if (indices.length === 0) return null
  return indices
    .slice(1)
    .reduce<SplitTree>((acc, i) => ({ dir: 'v', a: acc, b: { leaf: i } }), { leaf: indices[0] })
}
