import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { discoverSessions, SessionTailer } from '../transcripts/index.js'
import type { SessionInfo, TailerState, TranscriptEvent, TranscriptQuestionItem } from '../transcripts/index.js'
import { occupantForTty } from '../core/occupant.js'
import type { Pane } from '../core/types.js'
import { SCREEN_CALL_PREFIX, type ClaudeScreenQuestion } from '../core/claude-question-screen.js'

const execFileP = promisify(execFile)

/** Reserved epoch namespace for bridge-synthesized events (permission
 * requests come from screen detection, not the transcript files, so they
 * must never collide with line-number keys). */
export const SYNTHETIC_EPOCH = 900000

const STATE_DIR = join(homedir(), '.termbus')
const STATE_FILE = join(STATE_DIR, 'bridge-transcripts.json')

interface PersistedState {
  tailers: Record<string, TailerState>
  /** unanswered questions survive a bridge restart (the tailer resumes past them) */
  questions?: Record<string, OpenQuestion>
}

/** A question the agent asked that has no answer in the transcript yet. */
export interface OpenQuestion {
  callId: string
  sessionId: string
  agent: 'claude' | 'codex'
  items: TranscriptQuestionItem[]
  allowOther: boolean
  ts: string
}

const MAX_OPEN_QUESTIONS = 50

/** Fold transcript events into the open-question set: a `question` opens,
 * the tool_result carrying the same callId closes. Pure — unit-testable. */
export function applyQuestionEvents(open: Map<string, OpenQuestion>, events: TranscriptEvent[]): void {
  for (const ev of events) {
    const q = ev.question
    if (!q) continue
    if (ev.kind === 'question' && q.items && q.items.length) {
      open.set(q.callId, {
        callId: q.callId,
        sessionId: ev.sessionId,
        agent: ev.agent,
        items: q.items,
        allowOther: q.allowOther === true,
        ts: ev.ts,
      })
    } else if (ev.kind === 'tool_result') {
      open.delete(q.callId)
    }
  }
  // bounded: oldest first out (Map keeps insertion order)
  while (open.size > MAX_OPEN_QUESTIONS) open.delete(open.keys().next().value as string)
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
  /** pane link last declared to the relay per session */
  private postedLinks = new Map<string, string | null>()
  private openQuestions = new Map<string, OpenQuestion>(Object.entries(this.state.questions ?? {}))

  /** An unanswered question by callId (from this Mac's own transcripts). */
  openQuestion(callId: string): OpenQuestion | undefined {
    return this.openQuestions.get(callId)
  }
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
      // null means the probe failed (process may have been starting) — retry those
      if (!this.paneCwdCache.get(p.id)) this.paneCwdCache.set(p.id, await paneCwd(p.tty))
      agentPanes.push({ paneId: p.id, kind: occ.kind, cwd: this.paneCwdCache.get(p.id) ?? null })
    }
    this.links = linkSessionsToPanes(
      list.map((s) => ({ sessionId: s.sessionId, agent: s.agent, cwd: s.cwd, lastActivity: s.lastActivity })),
      agentPanes,
    )
  }

  private postedFingerprints = new Set<string>()

  /** Synthesize a permission_request event for a pane at a prompt. One event
   * per (pane, fingerprint): the seq derives from the fingerprint, so the
   * same prompt is idempotent server-side AND deduped bridge-side. */
  syntheticPermissionEvent(
    paneId: string,
    screenTail: string,
    fingerprint: string,
  ): { session: SessionInfo; event: TranscriptEvent } | null {
    const dedupeKey = `${paneId}:${fingerprint}`
    if (this.postedFingerprints.has(dedupeKey)) return null
    const entry = [...this.links.entries()].find(([, p]) => p === paneId)
    if (!entry) return null
    const rec = this.tailers.get(entry[0])
    if (!rec) return null
    this.postedFingerprints.add(dedupeKey)
    let seqHash = 0
    for (const c of fingerprint) seqHash = ((seqHash * 33) ^ c.charCodeAt(0)) >>> 0
    return {
      session: rec.info,
      event: {
        v: 1,
        agent: rec.info.agent,
        sessionId: rec.info.sessionId,
        epoch: SYNTHETIC_EPOCH,
        seq: seqHash % 2147483647,
        subSeq: 0,
        ts: new Date().toISOString(),
        kind: 'permission_request',
        text: screenTail,
        meta: { promptFingerprint: fingerprint },
      },
    }
  }

  /** paneId → the screen-built question card currently shown in HQ */
  private screenCards = new Map<string, { callId: string; key: string; info: SessionInfo }>()
  private screenSeq = 0

  /**
   * Reconcile a Claude pane's visible AskUserQuestion step with HQ: when the
   * step changes (answered, navigated, closed) the previous card is resolved
   * as superseded and the new step becomes a card. Returns the events to post;
   * [] when nothing changed. A step with no linked session yet is retried on
   * the next call (nothing is recorded for it).
   */
  screenQuestionEvents(paneId: string, parsed: ClaudeScreenQuestion | null): Array<{ session: SessionInfo; event: TranscriptEvent }> {
    const callId = parsed ? SCREEN_CALL_PREFIX + parsed.fingerprint : null
    const prev = this.screenCards.get(paneId)
    if (prev && prev.callId === callId) return []
    const out: Array<{ session: SessionInfo; event: TranscriptEvent }> = []
    const ev = (info: SessionInfo, key: string, kind: TranscriptEvent['kind'], question: TranscriptEvent['question']): TranscriptEvent => ({
      v: 1,
      agent: 'claude',
      sessionId: info.sessionId,
      epoch: SYNTHETIC_EPOCH,
      seq: seqOf(key),
      subSeq: 0,
      ts: new Date().toISOString(),
      kind,
      tool: { name: 'AskUserQuestion' },
      question,
    })
    if (prev) {
      out.push({ session: prev.info, event: ev(prev.info, `${prev.key}#done`, 'tool_result', { callId: prev.callId, superseded: true }) })
      this.screenCards.delete(paneId)
    }
    if (!parsed || !callId) return out
    const entry = [...this.links.entries()].find(([, p]) => p === paneId)
    const rec = entry ? this.tailers.get(entry[0]) : undefined
    if (!rec || rec.info.agent !== 'claude') return out
    const key = `${callId}#${this.screenSeq++}`
    const question: TranscriptEvent['question'] =
      parsed.step === 'review'
        ? { callId, items: [], screen: { step: 'review', tabs: parsed.tabs, review: parsed.review } }
        : {
            callId,
            allowOther: !parsed.multiSelect,
            items: [
              {
                key: 'screen',
                question: parsed.question,
                multiSelect: parsed.multiSelect,
                options: parsed.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
              },
            ],
            screen: {
              step: 'question',
              tabs: parsed.tabs,
              ...(parsed.multiSelect ? { ticked: parsed.options.flatMap((o, i) => (o.ticked ? [i] : [])) } : {}),
            },
          }
    out.push({ session: rec.info, event: ev(rec.info, key, 'question', question) })
    this.screenCards.set(paneId, { callId, key, info: rec.info })
    return out
  }

  hasScreenCard(paneId: string): boolean {
    return this.screenCards.has(paneId)
  }

  /** Drop a pane's card state so the next reconcile re-posts it (after a failed POST). */
  forgetScreenCard(paneId: string): void {
    this.screenCards.delete(paneId)
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
      if (events.length === 0) {
        // a session blocked on a question posts nothing more, so a pane link
        // discovered after its last batch would never reach the relay —
        // re-declare the session whenever its link changes
        const linked = this.links.get(info.sessionId) ?? null
        if (this.postedLinks.get(info.sessionId) !== linked) {
          const res = await this.api('/api/bridge/transcript', {
            method: 'POST',
            body: JSON.stringify({
              sessions: [{ sessionId: info.sessionId, agent: info.agent, cwd: info.cwd ?? null, paneId: linked }],
              events: [],
            }),
          }).catch(() => null)
          if (res?.ok) this.postedLinks.set(info.sessionId, linked)
        }
        continue
      }
      // a question needs its pane link to be answerable — don't wait for the
      // slow link cadence (the session file may be seconds old)
      if (events.some((e) => e.kind === 'question') && !this.links.has(info.sessionId)) {
        await this.refreshLinks(panes, sessions)
      }
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
        this.postedLinks.set(info.sessionId, this.links.get(info.sessionId) ?? null)
        applyQuestionEvents(this.openQuestions, events)
        this.state.tailers[info.sessionId] = tailer.getState()
        this.state.questions = Object.fromEntries(this.openQuestions)
        saveState(this.state)
      } else {
        // relay refused: drop the tailer so it resumes from the last
        // persisted (accepted) position next tick
        this.tailers.delete(info.sessionId)
      }
    }
  }

  /** Push a synthesized event immediately (permission prompts can't wait). */
  async postSynthetic(payload: { session: SessionInfo; event: TranscriptEvent }): Promise<boolean> {
    const res = await this.api('/api/bridge/transcript', {
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
    }).catch(() => null)
    return !!res && res.ok
  }
}

function seqOf(key: string): number {
  let h = 0
  for (const c of key) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return h % 2147483647
}
