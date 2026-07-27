import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { discoverSessions, SessionTailer } from '../transcripts/index.js'
import type { SessionInfo, TailerState, TranscriptEvent } from '../transcripts/index.js'
import { occupantForTty } from '../core/occupant.js'
import type { Pane } from '../core/types.js'

const execFileP = promisify(execFile)

/** Reserved epoch namespace for bridge-synthesized events (permission
 * requests come from screen detection, not the transcript files, so they
 * must never collide with line-number keys). */
export const SYNTHETIC_EPOCH = 900000

const STATE_DIR = join(homedir(), '.termbus')
const STATE_FILE = join(STATE_DIR, 'bridge-transcripts.json')

interface PersistedState {
  tailers: Record<string, TailerState>
}

function loadState(): PersistedState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedState
  } catch {
    return { tailers: {} }
  }
}

function saveState(state: PersistedState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state))
}

/**
 * Link sessions to panes: same agent kind + one cwd is a prefix of the other.
 * Ambiguity resolves to the most recently active session; a session links to
 * at most one pane and vice versa. Pure — unit-testable.
 */
export function linkSessionsToPanes(
  sessions: Array<Pick<SessionInfo, 'sessionId' | 'agent' | 'cwd' | 'lastActivity'>>,
  panes: Array<{ paneId: string; kind: string; cwd: string | null }>,
): Map<string, string> {
  const links = new Map<string, string>() // sessionId → paneId
  const takenPanes = new Set<string>()
  const sorted = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity)
  for (const s of sorted) {
    if (!s.cwd) continue
    const candidates = panes.filter(
      (p) =>
        !takenPanes.has(p.paneId) &&
        p.kind === s.agent &&
        p.cwd !== null &&
        (p.cwd.startsWith(s.cwd!) || s.cwd!.startsWith(p.cwd)),
    )
    if (candidates.length === 0) continue
    // prefer the longest common path (most specific match)
    candidates.sort((a, b) => Math.min(b.cwd!.length, s.cwd!.length) - Math.min(a.cwd!.length, s.cwd!.length))
    links.set(s.sessionId, candidates[0].paneId)
    takenPanes.add(candidates[0].paneId)
  }
  return links
}

async function paneCwd(tty: string): Promise<string | null> {
  try {
    const ttyName = tty.replace(/^\/dev\//, '')
    const { stdout } = await execFileP('ps', ['-t', ttyName, '-o', 'pid=,comm='])
    const agentRow = stdout
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
      .find((m) => m && /(^|\/)(claude|codex)$/.test(m[2]))
    if (!agentRow) return null
    const { stdout: lsofOut } = await execFileP('lsof', ['-a', '-p', agentRow[1], '-d', 'cwd', '-Fn'])
    const line = lsofOut.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

export interface FeederApi {
  (path: string, init?: RequestInit): Promise<Response>
}

/**
 * Streams agent-session transcripts to the relay. Owned by the bridge loop:
 * call tick() every interval; pane links refresh on a slower cadence.
 */
export class TranscriptFeeder {
  private tailers = new Map<string, { info: SessionInfo; tailer: SessionTailer }>()
  private state = loadState()
  private links = new Map<string, string>()
  private paneCwdCache = new Map<string, string | null>()
  private tickCount = 0

  constructor(private readonly api: FeederApi) {}

  linkedPane(sessionId: string): string | undefined {
    return this.links.get(sessionId)
  }

  private lastSessions: SessionInfo[] = []

  /** Recompute session→pane links now. Called on cadence by tick(), and
   * on-demand by the bridge when a prompt fires on a not-yet-linked pane. */
  async refreshLinks(panes: Pane[], sessions?: SessionInfo[]): Promise<void> {
    const list = sessions ?? this.lastSessions
    if (sessions) this.lastSessions = sessions
    const agentPanes: Array<{ paneId: string; kind: string; cwd: string | null }> = []
    for (const p of panes) {
      const occ = await occupantForTty(p.tty)
      if (occ.kind !== 'claude' && occ.kind !== 'codex') continue
      if (!this.paneCwdCache.has(p.id)) this.paneCwdCache.set(p.id, await paneCwd(p.tty))
      agentPanes.push({ paneId: p.id, kind: occ.kind, cwd: this.paneCwdCache.get(p.id) ?? null })
    }
    this.links = linkSessionsToPanes(
      list.map((s) => ({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd, lastActivity: s.lastActivity })),
      agentPanes,
    )
  }

  /** Synthesize a permission_request event for a pane at a prompt. */
  syntheticPermissionEvent(
    paneId: string,
    screenTail: string,
    fingerprint: string,
  ): { session: SessionInfo; event: TranscriptEvent } | null {
    const entry = [...this.links.entries()].find(([, p]) => p === paneId)
    if (!entry) return null
    const rec = this.tailers.get(entry[0])
    if (!rec) return null
    return {
      session: rec.info,
      event: {
        v: 1,
        agent: rec.info.agent,
        sessionId: rec.info.sessionId,
        epoch: SYNTHETIC_EPOCH,
        seq: Math.floor(Date.now() / 1000),
        subSeq: 0,
        ts: new Date().toISOString(),
        kind: 'permission_request',
        text: screenTail,
        meta: { promptFingerprint: fingerprint },
      },
    }
  }

  async tick(panes: Pane[]): Promise<void> {
    this.tickCount++
    const sessions = (await discoverSessions({ activeWindowMs: 24 * 3600 * 1000 })).slice(0, 8)
    this.lastSessions = sessions

    for (const info of sessions) {
      if (!this.tailers.has(info.sessionId)) {
        const initialState = this.state.tailers[info.sessionId]
        this.tailers.set(info.sessionId, {
          info,
          tailer: new SessionTailer(info, initialState ? { initialState } : {}),
        })
      }
    }

    // refresh pane links every 10 ticks (lsof is not free)
    if (this.tickCount === 1 || this.tickCount % 10 === 0) {
      await this.refreshLinks(panes, sessions)
    }

    for (const { info, tailer } of this.tailers.values()) {
      let events: TranscriptEvent[]
      try {
        events = await tailer.poll()
      } catch {
        continue // file may have vanished; next discovery cycle drops it
      }
      if (events.length === 0) continue
      let allPosted = true
      for (let i = 0; i < events.length; i += 400) {
        const chunk = events.slice(i, i + 400)
        const res = await this.api('/api/bridge/transcript', {
          method: 'POST',
          body: JSON.stringify({
            sessions: [
              {
                sessionId: info.sessionId,
                agent: info.agent,
                cwd: info.cwd ?? null,
                paneId: this.links.get(info.sessionId) ?? null,
              },
            ],
            events: chunk,
          }),
        }).catch(() => null)
        if (!res || !res.ok) {
          allPosted = false
          break
        }
      }
      if (allPosted) {
        this.state.tailers[info.sessionId] = tailer.getState()
        saveState(this.state)
      } else {
        // relay refused: drop the tailer so it resumes from the last
        // persisted (accepted) position next tick
        this.tailers.delete(info.sessionId)
      }
    }
  }

  /** Push a synthesized event immediately (permission prompts can't wait). */
  async postSynthetic(payload: { session: SessionInfo; event: TranscriptEvent }): Promise<void> {
    await this.api('/api/bridge/transcript', {
      method: 'POST',
      body: JSON.stringify({
        sessions: [
          {
            sessionId: payload.session.sessionId,
            agent: payload.session.agent,
            cwd: payload.session.cwd ?? null,
            paneId: this.links.get(payload.session.sessionId) ?? null,
          },
        ],
        events: [payload.event],
      }),
    }).catch(() => {})
  }
}
