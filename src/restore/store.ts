import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Generation, SavedAgent, SavedPane, SnapshotStore } from './types.js'

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
  snap: { instance: string | null; agents: SavedAgent[]; layout?: SavedPane[]; now: number },
  max = DEFAULT_MAX_GENERATIONS,
): SnapshotStore {
  const last = store.generations[store.generations.length - 1]
  if (last && last.instance === snap.instance && sameAgents(last.agents, snap.agents)) {
    return {
      ...store,
      // same state: refresh the timestamp and the (cosmetic) titles
      generations: [
        ...store.generations.slice(0, -1),
        { ...last, lastSeenAt: snap.now, agents: snap.agents, ...(snap.layout ? { layout: snap.layout } : {}) },
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
  }
  return { v: 1, nextId: store.nextId + 1, generations: [...store.generations, gen].slice(-max) }
}

/**
 * A state the terminal sat in for at least this long. Shutdown (iTerm2
 * quitting, the Mac powering off) kills agents one by one over a few seconds;
 * those half-closed states are short-lived and never stable, while closing an
 * agent on purpose leaves a state that persists.
 */
export const STABLE_MS = 45_000

const stable = (g: Generation) => g.lastSeenAt - g.takenAt >= STABLE_MS

/**
 * What `restore` brings back by default: the last STABLE state of the most
 * recent terminal instance other than the running one (its last state if
 * none was stable). If that state had no agents — everything was closed on
 * purpose — there is nothing to restore; never reach further back silently.
 */
export function pickGeneration(store: SnapshotStore, currentInstance: string | null): Generation | null {
  const gens = store.generations
  let i = gens.length - 1
  if (currentInstance !== null) {
    while (i >= 0 && gens[i].instance === currentInstance) i--
  }
  if (i < 0) return null
  const instance = gens[i].instance
  let pick: Generation = gens[i]
  for (let j = i; j >= 0 && gens[j].instance === instance; j--) {
    if (stable(gens[j])) {
      pick = gens[j]
      break
    }
  }
  return pick.agents.length > 0 ? pick : null
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
