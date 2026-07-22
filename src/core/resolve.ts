import { AmbiguousTargetError, TargetNotFoundError } from './errors.js'
import type { Pane } from './types.js'

/**
 * Resolution order: "self" keyword → exact session id → label (w1.t2.p1) →
 * tty (with or without /dev/) → exact title → unique title substring.
 */
export function resolveTarget(panes: Pane[], target: string): Pane {
  const t = target.trim()
  const tl = t.toLowerCase()

  if (tl === 'self') {
    const self = panes.find((p) => p.isSelf)
    if (self) return self
    throw new TargetNotFoundError(t)
  }

  const byId = panes.find((p) => p.id.toLowerCase() === tl)
  if (byId) return byId

  const byLabel = panes.find((p) => p.label.toLowerCase() === tl)
  if (byLabel) return byLabel

  const byTty = panes.find((p) => p.tty === t || p.tty === `/dev/${t}`)
  if (byTty) return byTty

  const exactTitle = panes.filter((p) => p.title.toLowerCase() === tl)
  if (exactTitle.length === 1) return exactTitle[0]
  if (exactTitle.length > 1) throw new AmbiguousTargetError(t, exactTitle)

  const sub = panes.filter((p) => p.title.toLowerCase().includes(tl))
  if (sub.length === 1) return sub[0]
  if (sub.length > 1) throw new AmbiguousTargetError(t, sub)

  throw new TargetNotFoundError(t)
}
