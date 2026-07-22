import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { agentScreenState, type AgentScreenState } from '../core/idle.js'
import { occupantForTty } from '../core/occupant.js'
import type { AgentKind } from '../core/types.js'

export async function cmdList(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } } })
  const backend = detectBackend()
  const panes = await backend.listPanes()
  const enriched = await Promise.all(
    panes.map(async (p) => {
      const occ = await occupantForTty(p.tty)
      let state: AgentScreenState | null = null
      if (occ.kind === 'claude' || occ.kind === 'codex') {
        try {
          state = agentScreenState(occ.kind as AgentKind, await backend.readScreen(p.id))
        } catch {
          // pane may have closed between list and read; leave state unknown
        }
      }
      return { ...p, occupant: occ.kind, occupantCommand: occ.command, state, busy: state === 'busy' }
    }),
  )
  if (values.json) {
    console.log(JSON.stringify(enriched, null, 2))
    return
  }
  console.log('LABEL      OCCUPANT  STATE   TTY        TITLE')
  for (const p of enriched) {
    const state = p.state === 'awaiting-input' ? 'input!' : (p.state ?? '-')
    const title = p.title.length > 46 ? `${p.title.slice(0, 45)}…` : p.title
    console.log(
      `${p.label.padEnd(10)} ${p.occupant.padEnd(9)} ${state.padEnd(7)} ${p.tty.replace('/dev/', '').padEnd(10)} ${title}${p.isSelf ? '  (self)' : ''}`,
    )
  }
}
