import { describe, expect, it } from 'vitest'
import { firstLeaf, inferSplitTree, pruneTree } from '../src/restore/layout.js'

// Real sizes captured from iTerm2 on 2026-10-08
describe('inferSplitTree', () => {
  it('one tall pane left, two stacked on the right (38x23 | 40x11 / 40x11)', () => {
    const t = inferSplitTree([{ cols: 38, rows: 23 }, { cols: 40, rows: 11 }, { cols: 40, rows: 11 }], { w: 570, h: 462 })
    expect(t).toEqual({ dir: 'v', a: { leaf: 0 }, b: { dir: 'h', a: { leaf: 1 }, b: { leaf: 2 } } })
  })

  it('two shells on top, three agents below (101x14 ×2 over 66/67/67x28)', () => {
    const t = inferSplitTree(
      [
        { cols: 101, rows: 14 },
        { cols: 101, rows: 14 },
        { cols: 66, rows: 28 },
        { cols: 67, rows: 28 },
        { cols: 67, rows: 28 },
      ],
      { w: 1438, h: 854 },
    )
    expect(t?.['dir' as keyof typeof t]).toBe('h')
    const top = (t as { a: unknown }).a
    expect(top).toEqual({ dir: 'v', a: { leaf: 0 }, b: { leaf: 1 } })
    const bottom = (t as { b: { dir: string } }).b
    expect(bottom.dir).toBe('v') // three side by side (nesting either way is the same picture)
  })

  it('two equal side-by-side panes vs stacked: the window shape decides', () => {
    const two = [
      { cols: 100, rows: 44 },
      { cols: 102, rows: 44 },
    ]
    expect(inferSplitTree(two, { w: 1438, h: 854 })).toEqual({ dir: 'v', a: { leaf: 0 }, b: { leaf: 1 } })
    const stacked = [
      { cols: 204, rows: 22 },
      { cols: 204, rows: 23 },
    ]
    expect(inferSplitTree(stacked, { w: 1438, h: 854 })).toEqual({ dir: 'h', a: { leaf: 0 }, b: { leaf: 1 } })
  })

  it('single pane and empty', () => {
    expect(inferSplitTree([{ cols: 204, rows: 46 }])).toEqual({ leaf: 0 })
    expect(inferSplitTree([])).toBeNull()
  })
})

describe('pruneTree', () => {
  const t = { dir: 'v' as const, a: { leaf: 0 }, b: { dir: 'h' as const, a: { leaf: 1 }, b: { leaf: 2 } } }
  it('collapses a split that loses a side', () => {
    expect(pruneTree(t, new Set([0, 2]))).toEqual({ dir: 'v', a: { leaf: 0 }, b: { leaf: 2 } })
    expect(pruneTree(t, new Set([1, 2]))).toEqual({ dir: 'h', a: { leaf: 1 }, b: { leaf: 2 } })
    expect(pruneTree(t, new Set())).toBeNull()
  })
  it('firstLeaf', () => {
    expect(firstLeaf(t)).toBe(0)
  })
})
