import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { ensureDeliverable, isAgentKind, paneState } from '../core/delivery.js'
import { buildEnvelope, envelopeId } from '../core/envelope.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { applySnapshots, diffStates, type WatchSnapshot } from '../core/watch.js'
import type { Backend, Pane } from '../core/types.js'

const USAGE =
  'usage: termbus bridge --relay <url> --secret <s> [--interval S]\n' +
  'Connects this Mac to a termbus-hq deployment (outbound only). Runs until Ctrl-C.'

const FOOTER_LINES = 15

export function promptFingerprint(screen: string): string {
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n').trim()
  return createHash('sha256').update(tail).digest('hex').slice(0, 24)
}

interface HqAction {
  id: number
  paneId: string
  paneLabel: string
  kind: 'approve' | 'reject' | 'send'
  payload: string | null
  promptFingerprint: string | null
}

async function api(base: string, secret: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function snapshotPanes(backend: Backend): Promise<Array<WatchSnapshot & { occupant: string; screen?: string }>> {
  const panes = await backend.listPanes()
  const out: Array<WatchSnapshot & { occupant: string; screen?: string }> = []
  for (const p of panes.filter((x: Pane) => !x.isSelf)) {
    try {
      const occ = await occupantForTty(p.tty)
      const screen = isAgentKind(occ.kind) ? await backend.readScreen(p.id) : ''
      const state = paneState(occ, screen)
      const snap: WatchSnapshot & { occupant: string; screen?: string } = {
        id: p.id,
        label: p.label,
        title: p.title,
        state,
        occupant: occ.kind,
      }
      // agent panes ship a footer preview so HQ can render a quick peek;
      // shells/commands never leak screen content
      if (isAgentKind(occ.kind)) snap.screen = screen.split('\n').slice(-FOOTER_LINES).join('\n')
      out.push(snap)
    } catch {
      // pane closed mid-scan
    }
  }
  return out
}

async function executeAction(backend: Backend, action: HqAction): Promise<{ status: string; outcome?: string }> {
  const panes = await backend.listPanes()
  const pane = panes.find((p) => p.id === action.paneId)
  if (!pane) return { status: 'failed', outcome: 'pane no longer exists' }
  const occ = await occupantForTty(pane.tty)

  if (action.kind === 'approve' || action.kind === 'reject') {
    // Verify the SAME prompt is still on screen before touching the pane —
    // an Enter meant for prompt A must never land on prompt B.
    const screen = await backend.readScreen(pane.id)
    if (paneState(occ, screen) !== 'awaiting-input') {
      return { status: 'stale', outcome: 'pane is no longer at a prompt' }
    }
    if (!action.promptFingerprint) {
      return { status: 'failed', outcome: 'action has no prompt fingerprint — refusing to type blind' }
    }
    if (promptFingerprint(screen) !== action.promptFingerprint) {
      return { status: 'stale', outcome: 'a different prompt is showing now' }
    }
    await backend.sendText(pane.id, action.kind === 'approve' ? '\r' : '\u001b', false)
    return { status: 'done' }
  }

  if (action.kind === 'send') {
    if (!action.payload) return { status: 'failed', outcome: 'empty payload' }
    const { outcome } = await ensureDeliverable(
      { backend, clock: defaultClock, probeOccupant: () => occupantForTty(pane.tty) },
      pane,
      occ,
      'queue',
      { timeoutMs: 0, pollMs: 1000 },
    )
    const enveloped = isAgentKind(occ.kind)
      ? `${buildEnvelope({ label: 'hq', kind: 'shell' }, envelopeId())} ${action.payload}`
      : action.payload
    await backend.sendText(pane.id, enveloped, true)
    return { status: 'done', outcome: outcome === 'queued' ? 'queued (pane was busy)' : 'delivered' }
  }

  return { status: 'failed', outcome: `unknown action kind ${action.kind}` }
}

export async function cmdBridge(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: 'string' },
      secret: { type: 'string' },
      interval: { type: 'string' },
    },
  })
  const relay = values.relay?.replace(/\/$/, '')
  const secret = values.secret ?? process.env.TERMBUS_BRIDGE_SECRET
  if (!relay || !secret) throw new TermbusError(USAGE)
  if (relay.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(relay)) {
    throw new TermbusError('refusing plain http to a non-local relay — the bridge secret would travel unencrypted')
  }
  const intervalMs = (values.interval ? Number(values.interval) : 1) * 1000
  const backend = detectBackend()

  console.log(`bridge → ${relay} (Ctrl-C to stop)`)
  let prev = new Map<string, WatchSnapshot>()
  let failures = 0
  // panes we delivered a send to and owe HQ the agent's reply
  const awaitingReply = new Map<string, { label: string; since: number; sawBusy: boolean }>()
  for (;;) {
    try {
      const snaps = await snapshotPanes(backend)
      const events = diffStates(prev, snaps).map((ev) => {
        const snap = snaps.find((s) => s.id === ev.id)
        return {
          paneId: ev.id,
          label: ev.label,
          title: ev.title,
          from: ev.from,
          to: ev.to,
          screen: snap?.screen,
          promptFingerprint: snap?.screen ? promptFingerprint(snap.screen) : undefined,
        }
      })
      const sync = await api(relay, secret, '/api/bridge/sync', {
        method: 'POST',
        body: JSON.stringify({
          panes: snaps.map((s) => ({
            paneId: s.id,
            label: s.label,
            title: s.title,
            occupant: s.occupant,
            state: s.state,
            screen: s.screen,
          })),
          events,
        }),
      })
      if (!sync.ok) throw new Error(`sync ${sync.status}`)
      prev = applySnapshots(prev, snaps) // only after the relay has the events — a failed POST retries them

      for (const [paneId, wait] of awaitingReply) {
        const snap = snaps.find((x) => x.id === paneId)
        if (!snap || Date.now() - wait.since > 300_000) {
          awaitingReply.delete(paneId)
          continue
        }
        if (snap.state === 'busy') wait.sawBusy = true
        if (snap.state === 'idle' && (wait.sawBusy || Date.now() - wait.since > 15_000)) {
          awaitingReply.delete(paneId)
          if (snap.screen) {
            await api(relay, secret, '/api/bridge/message', {
              method: 'POST',
              body: JSON.stringify({ paneLabel: wait.label, body: snap.screen }),
            }).catch(() => {})
          }
        }
      }

      const work = await api(relay, secret, '/api/bridge/work')
      if (work.ok) {
        const { actions } = (await work.json()) as { actions: HqAction[] }
        for (const action of actions) {
          const result = await executeAction(backend, action).catch((e: unknown) => ({
            status: 'failed',
            outcome: e instanceof Error ? e.message : String(e),
          }))
          console.log(`action #${action.id} ${action.kind} → ${action.paneLabel}: ${result.status}${result.outcome ? ` (${result.outcome})` : ''}`)
          if (action.kind === 'send' && result.status === 'done') {
            awaitingReply.set(action.paneId, { label: action.paneLabel, since: Date.now(), sawBusy: false })
          }
          const posted = await api(relay, secret, '/api/bridge/result', {
            method: 'POST',
            body: JSON.stringify({ actionId: action.id, ...result }),
          })
          if (!posted.ok) console.error(`result for #${action.id} not accepted (${posted.status}) — action stays claimed on the relay`)
        }
      }
      failures = 0
    } catch (err) {
      failures++
      console.error(`bridge error (${failures}): ${err instanceof Error ? err.message : String(err)}`)
      if (failures > 5) await defaultClock.sleep(Math.min(60_000, failures * 5000)) // back off, keep trying
    }
    await defaultClock.sleep(intervalMs)
  }
}
