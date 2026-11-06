import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Generation, SavedAgent, SavedPane, SavedTab, SnapshotStore } from './types.js'

export const DEFAULT_MAX_GENERATIONS = 50

export function emptyStore(): SnapshotStore {
  return { v: 1, nextId: 1, generations: [] }
}

// Identity of an agent pane. Titles are left out on purpose: agents animate
// them (spinner glyphs), and a title tick is not a new state.
const agentKey = (a: SavedAgent) =>
  JSON.stringify([a.windowIndex, a.tabIndex, a.paneIndex, a.kind, a.sessionId, a.cwd, a.command])

function sameAgents(a: SavedAgent[], b: SavedAgent[]): boolean {
  if (a.length !== b.length) return false
  const ka = a.map(agentKey).sort()
  const kb = b.map(agentKey).sort()
  return ka.every((k, i) => k === kb[i])
}

/** Record the current state. Pure: returns a new store. */
export function recordGeneration(
  store: SnapshotStore,
  snap: { instance: string | null; agents: SavedAgent[]; layout?: SavedPane[]; tabs?: SavedTab[]; now: number },
  max = DEFAULT_MAX_GENERATIONS,
): SnapshotStore {
  const last = store.generations[store.generations.length - 1]
  if (last && last.instance === snap.instance && sameAgents(last.agents, snap.agents)) {
    return {
      ...store,
      // same state: refresh the timestamp and the (cosmetic) titles; renaming a tab is cosmetic too
      generations: [
        ...store.generations.slice(0, -1),
        {
          ...last,
          lastSeenAt: snap.now,
          agents: snap.agents,
          ...(snap.layout ? { layout: snap.layout } : {}),
          ...(snap.tabs ? { tabs: snap.tabs } : {}),
        },
      ],
    }
  }
  const gen: Generation = {
    id: store.nextId,
    instance: snap.instance,
    takenAt: snap.now,
    lastSeenAt: snap.now,
    agents: snap.agents,
    ...(snap.layout ? { layout: snap.layout } : {}),
    ...(snap.tabs ? { tabs: snap.tabs } : {}),
  }
  return { v: 1, nextId: store.nextId + 1, generations: prune([...store.generations, gen], max) }
}

/** Earlier terminal runs whose last good state is always kept, however busy the current run is. */
export const KEEP_EARLIER_RUNS = 5

/**
 * Keep the newest `max` generations, plus every pinned one, plus the state each
 * of the last few earlier terminal runs ended in. Counting alone used to prune
 * the snapshot from before a crash: a new run records dozens of states an hour.
 */
export function prune(gens: Generation[], max = DEFAULT_MAX_GENERATIONS): Generation[] {
  if (gens.length <= max) return gens
  const keep = new Set<number>(gens.slice(-max).map((g) => g.id))
  for (const g of gens) if (g.pinned) keep.add(g.id)
  const current = gens[gens.length - 1].instance
  const seen: Array<string | null> = []
  for (let i = gens.length - 1; i >= 0 && seen.length < KEEP_EARLIER_RUNS; i--) {
    const inst = gens[i].instance
    if (inst === current || seen.includes(inst)) continue
    seen.push(inst)
    const pick = pickFromInstance(gens, i)
    if (pick) keep.add(pick.id)
  }
  return gens.filter((g) => keep.has(g.id))
}

/** The state to restore from the instance whose newest generation is gens[i]: its last stable state with agents. */
function pickFromInstance(gens: Generation[], i: number): Generation | null {
  const instance = gens[i].instance
  let lastWithAgents: Generation | null = null
  for (let j = i; j >= 0 && gens[j].instance === instance; j--) {
    if (gens[j].agents.length === 0) continue
    lastWithAgents ??= gens[j]
    if (stable(gens[j])) return gens[j]
  }
  return lastWithAgents
}

/**
 * A state the terminal sat in for at least this long. Shutdown (iTerm2
 * quitting, the Mac powering off) kills agents one by one over a few seconds;
 * those half-closed states are short-lived and never stable, while closing an
 * agent on purpose leaves a state that persists.
 */
export const STABLE_MS = 45_000

export const stable = (g: Generation) => g.lastSeenAt - g.takenAt >= STABLE_MS

/**
 * What `restore` brings back by default: the last STABLE state with agents of
 * the most recent terminal instance other than the running one (its last state
 * with agents if none was stable). Never reaches into an older instance.
 */
export function pickGeneration(store: SnapshotStore, currentInstance: string | null): Generation | null {
  const gens = store.generations
  let i = gens.length - 1
  if (currentInstance !== null) {
    while (i >= 0 && gens[i].instance === currentInstance) i--
  }
  if (i < 0) return null
  // A run that ended with no agents usually lost them all at once (a crash, a
  // logout) rather than closing them one by one on purpose: restore its last
  // state that had agents. `restore` says which state it picked and when.
  return pickFromInstance(gens, i)
}

export function loadStore(path: string): SnapshotStore {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as SnapshotStore
    if (s.v === 1 && Array.isArray(s.generations)) return s
  } catch {
    // missing or corrupt: start fresh
  }
  return emptyStore()
}

/** Atomic replace, so a crash mid-write never leaves a torn file. */
export function saveStore(path: string, store: SnapshotStore): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 1))
  renameSync(tmp, path)
}
