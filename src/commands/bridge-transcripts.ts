import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverSessions, SessionTailer } from '../transcripts/index.js'
import type { SessionInfo, TailerState, TranscriptEvent, TranscriptQuestionItem } from '../transcripts/index.js'
import { agentProcessForTty } from '../core/occupant.js'
import { probeAgentIdentity } from '../restore/identity.js'
import type { Pane } from '../core/types.js'
import { randomUUID } from 'node:crypto'
import { screenCallId, type ClaudeScreenQuestion } from '../core/claude-question-screen.js'


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
 * Link sessions to panes. EXACT first: each agent pane reports the
 * conversation its process is running (Claude's per-pid session file, the
 * rollout Codex holds open — see restore/identity.ts). Only panes whose
 * identity can't be read fall back to matching by working directory, and
 * only when that match is unambiguous (one session ↔ one pane). Several
 * agents in the same folder used to be paired by "most recently active",
 * which scrambled them — and HQ then typed messages into the wrong agent.
 * An unlinked chat is safe; a wrongly linked one is not. Pure — unit-testable.
 */
export function linkSessionsToPanes(
  sessions: Array<Pick<SessionInfo, 'sessionId' | 'agent' | 'cwd' | 'lastActivity'>>,
  panes: Array<{ paneId: string; kind: string; cwd: string | null; sessionId?: string | null }>,
): Map<string, string> {
  const links = new Map<string, string>() // sessionId → paneId
  for (const p of panes) if (p.sessionId) links.set(p.sessionId, p.paneId)
  const unknownPanes = panes.filter((p) => !p.sessionId && p.cwd !== null)
  const loose = sessions.filter((s) => s.cwd && !links.has(s.sessionId))
  const matches = (s: (typeof loose)[number], p: (typeof unknownPanes)[number]) =>
    p.kind === s.agent && (p.cwd!.startsWith(s.cwd!) || s.cwd!.startsWith(p.cwd!))
  for (const s of loose) {
    const cands = unknownPanes.filter((p) => matches(s, p))
    if (cands.length !== 1) continue
    // …and that pane must not match any other unlinked session either
    if (loose.filter((o) => matches(o, cands[0])).length !== 1) continue
    links.set(s.sessionId, cands[0].paneId)
  }
  return links
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
    const agentPanes: Array<{ paneId: string; kind: string; cwd: string | null; sessionId: string | null }> = []
    for (const p of panes) {
      const proc = await agentProcessForTty(p.tty)
      if (!proc) continue
      // which conversation is this process running? (re-read every refresh:
      // /clear or a resume switches it)
      const id = await probeAgentIdentity(proc.kind, proc.pid)
      agentPanes.push({ paneId: p.id, kind: proc.kind, cwd: id.cwd, sessionId: id.sessionId })
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
  private screenCards = new Map<string, { callId: string; key: string; fingerprint: string; info: SessionInfo }>()

  /**
   * Reconcile a Claude pane's visible AskUserQuestion step with HQ: when the
   * step changes (answered, navigated, closed) the previous card is resolved
   * as superseded and the new step becomes a card. Returns the events to post;
   * [] when nothing changed. A step with no linked session yet is retried on
   * the next call (nothing is recorded for it).
   */
  screenQuestionEvents(paneId: string, parsed: ClaudeScreenQuestion | null): Array<{ session: SessionInfo; event: TranscriptEvent }> {
    const prev = this.screenCards.get(paneId)
    if (prev && parsed && prev.fingerprint === parsed.fingerprint) return []
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
    if (!parsed) return out
    const entry = [...this.links.entries()].find(([, p]) => p === paneId)
    const rec = entry ? this.tailers.get(entry[0]) : undefined
    if (!rec || rec.info.agent !== 'claude') return out
    // a fresh random nonce per showing: unique across repeats AND restarts,
    // so neither the one-time answer slot nor the event key can collide
    const callId = screenCallId(paneId, randomUUID().slice(0, 12), parsed.fingerprint)
    const key = callId
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
    this.screenCards.set(paneId, { callId, key, fingerprint: parsed.fingerprint, info: rec.info })
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
