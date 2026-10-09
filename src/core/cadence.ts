/**
 * When the bridge talks to HQ. The local loop still looks at panes every
 * second (free — it's AppleScript on this Mac); this decides which of those
 * looks become HTTP requests. HQ runs on metered serverless hosting, and a
 * request per second per endpoint per Mac adds up to millions a month.
 *
 * - sync: only when something a person would notice changed (a pane opened
 *   or closed, an agent started/finished, a prompt or question appeared or
 *   changed), plus a heartbeat so HQ knows the Mac is alive.
 * - work: fast while something is "hot" (a prompt is waiting for an answer,
 *   or an action just ran — the user is likely interacting), slow otherwise.
 */

export const HEARTBEAT_MS = 60_000
export const WORK_FAST_MS = 1_000
export const WORK_IDLE_MS = 10_000
/** how long after activity the work poll stays fast */
export const HOT_MS = 120_000
/** a prompt waiting longer than this no longer keeps the poll fast */
export const PROMPT_HOT_MS = 10 * 60_000

export interface PaneDigestInput {
  id: string
  label: string
  title: string
  occupant: string
  state: string
  screen?: string
}

/** Agents animate their titles (spinners, timers): ignore leading glyphs. */
export function stableTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

/**
 * What HQ needs to be told about. Screens count only for panes waiting on
 * input (the prompt/question shown on the phone must be current); busy
 * screens redraw constantly and ride along with the heartbeat instead.
 */
export function paneDigest(panes: PaneDigestInput[]): string {
  return JSON.stringify(
    [...panes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, p.label, stableTitle(p.title), p.occupant, p.state, p.state === 'awaiting-input' ? (p.screen ?? '') : '']),
  )
}

export class Cadence {
  private lastSyncAt = -Infinity
  private lastDigest: string | null = null
  private lastWorkAt = -Infinity
  private lastActivityAt = -Infinity
  private promptSince = new Map<string, number>()

  /** Should this tick POST /sync? `hasEvents`: state transitions to report. */
  shouldSync(now: number, digest: string, hasEvents: boolean): boolean {
    return hasEvents || digest !== this.lastDigest || now - this.lastSyncAt >= HEARTBEAT_MS
  }

  /** Call only after HQ accepted the sync (a failed POST retries next tick). */
  synced(now: number, digest: string): void {
    this.lastSyncAt = now
    this.lastDigest = digest
  }

  /** Track which panes wait on a prompt, and since when. */
  observe(now: number, panes: Array<{ id: string; state: string }>, hasEvents: boolean): void {
    const waiting = new Set(panes.filter((p) => p.state === 'awaiting-input').map((p) => p.id))
    for (const id of [...this.promptSince.keys()]) if (!waiting.has(id)) this.promptSince.delete(id)
    for (const id of waiting) if (!this.promptSince.has(id)) this.promptSince.set(id, now)
    if (hasEvents) this.lastActivityAt = now
  }

  /** An action ran, or a reply is pending: the user is interacting. */
  activity(now: number): void {
    this.lastActivityAt = now
  }

  workInterval(now: number): number {
    const freshPrompt = [...this.promptSince.values()].some((since) => now - since < PROMPT_HOT_MS)
    return freshPrompt || now - this.lastActivityAt < HOT_MS ? WORK_FAST_MS : WORK_IDLE_MS
  }

  shouldPollWork(now: number): boolean {
    return now - this.lastWorkAt >= this.workInterval(now)
  }

  polledWork(now: number): void {
    this.lastWorkAt = now
  }
}
