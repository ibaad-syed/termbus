import { detectBackend } from '../backends/detect.js'
import { allAgents } from '../core/agents.js'
import { TermbusError } from '../core/errors.js'
import { loadMarks, markPane, unmarkPane, updateMarks } from '../core/marks.js'
import { foregroundForTty } from '../core/occupant.js'
import { resolveTarget } from '../core/resolve.js'

const USAGE =
  'usage: termbus mark <target> <kind> [--force]   treat the program running in that pane as agent <kind>\n' +
  '       termbus unmark <target>                  back to automatic detection\n' +
  'kinds: built in claude, codex, devin; more in ~/.termbus/agents.json\n' +
  'The mark lasts while that program runs. --force: allow marking a shell, ssh, REPL or editor.'

export async function cmdMark(argv: string[]): Promise<void> {
  const force = argv.includes('--force')
  const [target, kind, ...extra] = argv.filter((a) => a !== '--force')
  if (!target || !kind || extra.length) throw new TermbusError(`${USAGE}\nknown kinds: ${allAgents().map((a) => a.id).join(', ')}`)
  const pane = resolveTarget(await detectBackend().listPanes(), target)
  const fg = await foregroundForTty(pane.tty)
  updateMarks((m) => markPane(m, pane.id, kind, fg, { force }))
  console.log(
    `marked ${pane.label} (${pane.title}) as ${kind} — while "${fg!.command.split(/\s+/)[0]}" (pid ${fg!.pid}) runs there; \`termbus unmark ${pane.label}\` to undo`,
  )
}

export async function cmdUnmark(argv: string[]): Promise<void> {
  const [target, ...extra] = argv
  if (!target || extra.length) throw new TermbusError(USAGE)
  const pane = resolveTarget(await detectBackend().listPanes(), target)
  if (!(pane.id in loadMarks())) throw new TermbusError(`${pane.label} is not marked (its kind is detected automatically)`)
  updateMarks((m) => unmarkPane(m, pane.id))
  console.log(`unmarked ${pane.label} (${pane.title})`)
}
