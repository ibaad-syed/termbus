import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { ensureDeliverable, isAgentKind, resolveMode } from '../core/delivery.js'
import { buildEnvelope, detectSenderKind, envelopeId } from '../core/envelope.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { decodeRawEscapes } from '../core/raw.js'
import { resolveTarget } from '../core/resolve.js'

const USAGE =
  'usage: termbus send <target> <text> [--raw] [--no-submit] [--queue] [--wait] [--timeout S] [--force] [--plain]'

export async function cmdSend(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      raw: { type: 'boolean' },
      force: { type: 'boolean' },
      queue: { type: 'boolean' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      'no-submit': { type: 'boolean' },
      plain: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const [target, ...textParts] = positionals
  const text = textParts.join(' ')
  if (!target || !text) throw new TermbusError(USAGE)
  // --raw is deliberate TUI keystroke driving (answering dialogs, menus) —
  // gating it on busy/awaiting-input would block its main use case.
  const mode = values.raw && !values.queue && !values.wait ? 'force' : resolveMode(values)
  const timeoutMs = (values.timeout ? Number(values.timeout) : 300) * 1000
  const backend = detectBackend()
  const panes = await backend.listPanes()
  const pane = resolveTarget(panes, target)
  if (pane.isSelf) throw new TermbusError('refusing to send to self (would type into this pane)')

  const occ = await occupantForTty(pane.tty)
  const { outcome, waitedMs } = await ensureDeliverable(
    { backend, clock: defaultClock, probeOccupant: () => occupantForTty(pane.tty) },
    pane,
    occ,
    mode,
    { timeoutMs, pollMs: 1000 },
  )

  let payload = values.raw ? decodeRawEscapes(text) : text
  const submit = values.raw ? false : !values['no-submit']
  // Sender envelope: only for submitted prompts to agent panes. Raw keystrokes,
  // incremental --no-submit composition, shell targets, and --plain stay
  // byte-for-byte untouched.
  if (isAgentKind(occ.kind) && submit && !values.raw && !values.plain) {
    const selfLabel = panes.find((p) => p.isSelf)?.label ?? 'external'
    payload = `${buildEnvelope({ label: selfLabel, kind: await detectSenderKind() }, envelopeId())} ${payload}`
  }
  await backend.sendText(pane.id, payload, submit)

  if (outcome === 'queued') {
    console.log(
      `queued to ${pane.label} (${pane.title}) — pane is busy; the message is in its input queue and will be handled mid-turn or when current work finishes`,
    )
  } else if (waitedMs > 0) {
    console.log(`sent to ${pane.label} (${pane.title}) after waiting ${Math.round(waitedMs / 1000)}s for idle`)
  } else {
    console.log(`sent to ${pane.label} (${pane.title})`)
  }
}
