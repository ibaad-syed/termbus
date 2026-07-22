import { BusyPaneError, TermbusError, WaitTimeoutError } from './errors.js'
import { looksBusy } from './idle.js'
import type { AgentKind, Backend, Occupant, Pane } from './types.js'

export type DeliveryMode = 'refuse' | 'queue' | 'wait' | 'force'

/**
 * Per-agent delivery capabilities. Extensible: a new agent TUI is one row
 * here plus its busy markers in idle.ts.
 *
 * nativeQueue: the TUI accepts a submitted message while busy and surfaces it
 * itself (claude and codex both queue input typed mid-turn), so termbus can
 * deliver immediately and report "queued" instead of refusing.
 */
export const AGENT_CAPS: Record<AgentKind, { nativeQueue: boolean }> = {
  claude: { nativeQueue: true },
  codex: { nativeQueue: true },
}

export function isAgentKind(kind: Occupant['kind']): kind is AgentKind {
  return kind === 'claude' || kind === 'codex'
}

/**
 * Busy means "delivering now would collide with something": an agent mid-turn,
 * or a foreground program (sleep, build, dev server) owning the tty. An idle
 * shell prompt is not busy; unknown panes are treated as idle so the default
 * permissive path keeps working.
 */
export function paneBusy(occ: Occupant, screen: string): boolean {
  if (isAgentKind(occ.kind)) return looksBusy(occ.kind, screen)
  return occ.kind === 'command'
}

export interface DeliveryDeps {
  backend: Backend
  clock: { now(): number; sleep(ms: number): Promise<void> }
  /** Re-probe the pane's occupant (a running shell command ends by the fg
   * process changing, not by anything visible on screen). Defaults to the
   * static occupant snapshot, which is fine for agent panes. */
  probeOccupant?: () => Promise<Occupant>
}

export interface WaitOptions {
  timeoutMs: number
  pollMs: number
}

export interface DeliveryOutcome {
  outcome: 'idle' | 'queued'
  waitedMs: number
}

export async function waitForIdle(
  deps: DeliveryDeps,
  pane: Pane,
  occ: Occupant,
  opts: WaitOptions,
): Promise<DeliveryOutcome> {
  const probe = deps.probeOccupant ?? (async () => occ)
  const start = deps.clock.now()
  while (deps.clock.now() - start < opts.timeoutMs) {
    await deps.clock.sleep(opts.pollMs)
    const [fresh, screen] = await Promise.all([probe(), deps.backend.readScreen(pane.id)])
    if (!paneBusy(fresh, screen)) return { outcome: 'idle', waitedMs: deps.clock.now() - start }
  }
  throw new WaitTimeoutError(pane, deps.clock.now() - start)
}

/**
 * Gate a delivery on the pane's busy state according to mode:
 *  - force:  deliver now, no questions asked
 *  - refuse: (default) busy agent panes throw BusyPaneError; shell/command
 *            panes stay permissive for back-compat (raw keys to TUIs etc.)
 *  - queue:  busy agent with a native input queue → deliver now, report
 *            'queued'; anything else busy → error pointing at --wait
 *  - wait:   poll until idle (agents finish their turn, shells finish their
 *            foreground command), then deliver
 */
export async function ensureDeliverable(
  deps: DeliveryDeps,
  pane: Pane,
  occ: Occupant,
  mode: DeliveryMode,
  opts: WaitOptions,
): Promise<DeliveryOutcome> {
  if (mode === 'force') return { outcome: 'idle', waitedMs: 0 }
  if (mode === 'refuse' && !isAgentKind(occ.kind)) return { outcome: 'idle', waitedMs: 0 }

  const screen = await deps.backend.readScreen(pane.id)
  if (!paneBusy(occ, screen)) return { outcome: 'idle', waitedMs: 0 }

  switch (mode) {
    case 'refuse':
      throw new BusyPaneError(pane, screen)
    case 'queue': {
      if (isAgentKind(occ.kind) && AGENT_CAPS[occ.kind].nativeQueue) {
        return { outcome: 'queued', waitedMs: 0 }
      }
      throw new TermbusError(
        `pane ${pane.label} is busy running "${occ.command ?? occ.kind}", which has no input queue — use --wait instead`,
        4,
      )
    }
    case 'wait':
      return waitForIdle(deps, pane, occ, opts)
  }
}

/** Resolve --force/--queue/--wait flags into a single mode; they are mutually exclusive. */
export function resolveMode(flags: { force?: boolean; queue?: boolean; wait?: boolean }): DeliveryMode {
  const chosen = (['force', 'queue', 'wait'] as const).filter((f) => flags[f])
  if (chosen.length > 1) {
    throw new TermbusError(`--${chosen[0]} and --${chosen[1]} are mutually exclusive — pick one`)
  }
  return chosen[0] ?? 'refuse'
}
