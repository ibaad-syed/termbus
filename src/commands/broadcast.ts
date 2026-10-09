import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { ensureDeliverable, isAgentKind, paneState, resolveMode, type DeliveryMode } from '../core/delivery.js'
import { buildEnvelope, detectSenderKind, envelopeId } from '../core/envelope.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { loadOrg, resolveGroupTargets } from '../core/org.js'
import type { Occupant, Pane } from '../core/types.js'

const USAGE =
  'usage: termbus broadcast <@department|@all|target,target,…> <text> [--wait] [--force] [--timeout S] [--plain]\n' +
  'Sends one message to many agent panes. Busy agents get it in their input queue\n' +
  '(default; --wait delivers when each is idle, --force interrupts). Shell panes are\n' +
  'never typed into. Recipients see who sent it and that it went to a group.'

/** The line prepended so recipients know the message went to a group. */
export function groupPrefix(group: string | null, count: number): string {
  if (group?.toLowerCase() === '@all') return '(to all agents) '
  if (group) return `(to ${group}) `
  return count > 1 ? `(to ${count} agents) ` : ''
}

export interface DeliveryReport {
  pane: Pane
  result: 'sent' | 'queued' | 'skipped'
  reason?: string
}

/**
 * Shared by `broadcast` and `send` with a group target. `mode` is the busy
 * policy for each recipient; non-agent panes are always skipped (text would
 * run as a shell command).
 */
export async function deliverToMany(
  spec: string,
  text: string,
  mode: DeliveryMode,
  opts: { timeoutMs: number; plain?: boolean },
): Promise<{ reports: DeliveryReport[]; missing: string[]; group: string | null }> {
  const backend = detectBackend()
  const panes = await backend.listPanes()
  const occ = new Map<string, Occupant>()
  await Promise.all(panes.map(async (p) => occ.set(p.id, await occupantForTty(p.tty))))
  const isAgent = (p: Pane) => isAgentKind(occ.get(p.id)?.kind ?? 'unknown')
  const { panes: targets, group, missing } = resolveGroupTargets(panes, loadOrg(), spec, isAgent)
  if (targets.length === 0 && missing.length === 0) throw new TermbusError(`no agents matched "${spec}"`)
  const selfLabel = panes.find((p) => p.isSelf)?.label ?? 'external'
  const senderKind = await detectSenderKind()
  const prefix = groupPrefix(group, targets.length)
  const reports: DeliveryReport[] = []
  for (const pane of targets) {
    if (!isAgent(pane)) {
      reports.push({ pane, result: 'skipped', reason: 'not an agent pane' })
      continue
    }
    try {
      const { outcome } = await ensureDeliverable(
        { backend, clock: defaultClock, probeOccupant: () => occupantForTty(pane.tty) },
        pane,
        occ.get(pane.id)!,
        mode,
        { timeoutMs: opts.timeoutMs, pollMs: 1000 },
      )
      // re-check right before typing: waiting for idle can take minutes, and
      // an agent that exited leaves a shell that would run the text
      if (!isAgentKind((await occupantForTty(pane.tty)).kind)) {
        reports.push({ pane, result: 'skipped', reason: 'the agent exited' })
        continue
      }
      const body = `${prefix}${text.replace(/[\u0000-\u001f\u007f]+/g, ' ')}`
      const payload = opts.plain ? body : `${buildEnvelope({ label: selfLabel, kind: senderKind }, envelopeId())} ${body}`
      await backend.sendText(pane.id, payload, false)
      // Enter separately, and only if it's still an agent with no dialog up
      await defaultClock.sleep(200)
      const now = await occupantForTty(pane.tty)
      if (!isAgentKind(now.kind) || paneState(now, await backend.readScreen(pane.id)) === 'awaiting-input') {
        reports.push({ pane, result: 'skipped', reason: 'a prompt appeared — the text is in its input box, not submitted' })
        continue
      }
      await backend.sendText(pane.id, '\r', false)
      reports.push({ pane, result: outcome === 'queued' ? 'queued' : 'sent' })
    } catch (e) {
      reports.push({ pane, result: 'skipped', reason: e instanceof Error ? e.message.split('\n')[0] : String(e) })
    }
  }
  return { reports, missing, group }
}

export function printReports(r: { reports: DeliveryReport[]; missing: string[] }): void {
  for (const x of r.reports) {
    const what = x.result === 'queued' ? 'queued (busy)' : x.result
    console.log(`  ${what.padEnd(13)} ${x.pane.label.padEnd(10)} ${x.pane.title}${x.reason ? `  — ${x.reason}` : ''}`)
  }
  if (r.missing.length) console.log(`  ${r.missing.length} member pane(s) are not open right now`)
  const n = (k: DeliveryReport['result']) => r.reports.filter((x) => x.result === k).length
  console.log(`delivered to ${n('sent') + n('queued')} (${n('queued')} queued), skipped ${n('skipped')}`)
}

export async function cmdBroadcast(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      wait: { type: 'boolean' },
      force: { type: 'boolean' },
      queue: { type: 'boolean' },
      timeout: { type: 'string' },
      plain: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const [spec, ...parts] = positionals
  const text = parts.join(' ')
  if (!spec || !text) throw new TermbusError(USAGE)
  // broadcast never refuses busy agents by default: it queues
  const mode: DeliveryMode = values.wait || values.force ? resolveMode(values) : 'queue'
  const r = await deliverToMany(spec, text, mode, {
    timeoutMs: (values.timeout ? Number(values.timeout) : 300) * 1000,
    plain: values.plain,
  })
  printReports(r)
  if (!r.reports.some((x) => x.result !== 'skipped')) process.exitCode = 1
}
