import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { resolveTarget } from '../core/resolve.js'

export async function cmdCheck(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { lines: { type: 'string' } },
    allowPositionals: true,
  })
  const target = positionals[0]
  if (!target) throw new Error('usage: termbus check <target> [--lines N]')
  const backend = detectBackend()
  const pane = resolveTarget(await backend.listPanes(), target)
  let screen = await backend.readScreen(pane.id)
  screen = screen.replace(/\s+$/, '')
  if (values.lines) {
    const n = Number(values.lines)
    screen = screen.split('\n').slice(-n).join('\n')
  }
  console.log(screen)
}
