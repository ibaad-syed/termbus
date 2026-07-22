import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { BusyPaneError, TermbusError } from '../core/errors.js'
import { looksBusy } from '../core/idle.js'
import { occupantForTty } from '../core/occupant.js'
import { decodeRawEscapes } from '../core/raw.js'
import { resolveTarget } from '../core/resolve.js'
import type { AgentKind } from '../core/types.js'

export async function cmdSend(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      raw: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-submit': { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const [target, ...textParts] = positionals
  const text = textParts.join(' ')
  if (!target || !text) throw new TermbusError('usage: termbus send <target> <text> [--raw] [--no-submit] [--force]')
  const backend = detectBackend()
  const pane = resolveTarget(await backend.listPanes(), target)
  if (pane.isSelf) throw new TermbusError('refusing to send to self (would type into this pane)')

  const occ = await occupantForTty(pane.tty)
  if ((occ.kind === 'claude' || occ.kind === 'codex') && !values.force) {
    const screen = await backend.readScreen(pane.id)
    if (looksBusy(occ.kind as AgentKind, screen)) throw new BusyPaneError(pane, screen)
  }

  const payload = values.raw ? decodeRawEscapes(text) : text
  const submit = values.raw ? false : !values['no-submit']
  await backend.sendText(pane.id, payload, submit)
  console.log(`sent to ${pane.label} (${pane.title})`)
}
