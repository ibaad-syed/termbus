/**
 * Pure state-transition tracking for `termbus watch`. The command layer polls
 * panes and feeds snapshots in; this module reports what changed so alerts
 * fire exactly once per episode (a pane entering awaiting-input alerts on the
 * transition, not on every poll while it sits there).
 */

export interface WatchSnapshot {
  id: string
  label: string
  title: string
  state: string // idle | busy | awaiting-input | command-specific
}

export interface WatchEvent {
  id: string
  label: string
  title: string
  from: string | null // null = pane newly watched
  to: string | null // null = pane disappeared
}

export function diffStates(prev: Map<string, WatchSnapshot>, cur: WatchSnapshot[]): WatchEvent[] {
  const events: WatchEvent[] = []
  const seen = new Set<string>()
  for (const snap of cur) {
    seen.add(snap.id)
    const old = prev.get(snap.id)
    if (!old) {
      events.push({ id: snap.id, label: snap.label, title: snap.title, from: null, to: snap.state })
    } else if (old.state !== snap.state) {
      events.push({ id: snap.id, label: snap.label, title: snap.title, from: old.state, to: snap.state })
    }
  }
  for (const [id, old] of prev) {
    if (!seen.has(id)) {
      events.push({ id, label: old.label, title: old.title, from: old.state, to: null })
    }
  }
  return events
}

export function applySnapshots(prev: Map<string, WatchSnapshot>, cur: WatchSnapshot[]): Map<string, WatchSnapshot> {
  return new Map(cur.map((s) => [s.id, s]))
}
