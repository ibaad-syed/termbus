import { detectBackend } from '../backends/detect.js'
import { allAgents } from '../core/agents.js'
import { TermbusError } from '../core/errors.js'
import { applyMark, loadMarks, updateMarks } from '../core/marks.js'
import { resolveTarget } from '../core/resolve.js'

const USAGE =
  'usage: termbus mark <target> <kind>   treat the program in that pane as agent <kind>\n' +
  '       termbus unmark <target>        back to automatic detection\n' +
  'kinds: built in claude, codex, devin; more in ~/.termbus/agents.json'

export async function cmdMark(argv: string[]): Promise<void> {
  const [target, kind, ...extra] = argv
  if (!target || !kind || extra.length) throw new TermbusError(`${USAGE}\nknown kinds: ${allAgents().map((a) => a.id).join(', ')}`)
  const pane = resolveTarget(await detectBackend().listPanes(), target)
  updateMarks((m) => applyMark(m, pane.id, kind))
  console.log(`marked ${pane.label} (${pane.title}) as ${kind} — applies while a program runs there; \`termbus unmark ${pane.label}\` to undo`)
}

export async function cmdUnmark(argv: string[]): Promise<void> {
  const [target, ...extra] = argv
  if (!target || extra.length) throw new TermbusError(USAGE)
  const pane = resolveTarget(await detectBackend().listPanes(), target)
  if (!(pane.id in loadMarks())) throw new TermbusError(`${pane.label} is not marked (its kind is detected automatically)`)
  updateMarks((m) => applyMark(m, pane.id, null))
  console.log(`unmarked ${pane.label} (${pane.title})`)
}
