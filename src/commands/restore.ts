import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { TermbusError } from '../core/errors.js'
import type { Backend } from '../core/types.js'
import { liveAgents, snapshotFile, terminalInstance } from '../restore/capture.js'
import { planRestore } from '../restore/plan.js'
import { buildResumeArgv, launchScript, restoreShellLine } from '../restore/resume-command.js'
import { loadStore, pickGeneration } from '../restore/store.js'
import type { Generation, SavedAgent } from '../restore/types.js'

const USAGE =
  'usage: termbus restore [--dry-run] [--list] [--generation N]\n' +
  'Reopens the agent panes that were open before iTerm2 quit or the Mac\n' +
  'restarted, each resuming its own conversation. Agents already running are\n' +
  'skipped, so running it twice is harmless.\n' +
  '  --dry-run       show what would open, change nothing\n' +
  '  --list          list saved snapshots\n' +
  '  --generation N  restore a specific snapshot from --list'

const when = (ms: number) => new Date(ms).toLocaleString()

const describe = (a: SavedAgent) =>
  `${a.kind.padEnd(6)} ${(a.sessionId ?? '?').slice(0, 8)}  ${a.cwd ?? '?'}${a.title ? `  "${a.title.slice(0, 40)}"` : ''}`

function printList(gens: Generation[], current: string | null): void {
  if (gens.length === 0) {
    console.log('no snapshots yet — run `termbus snapshot --install` to start remembering')
    return
  }
  console.log('GEN   SAVED                    AGENTS  ITERM RUN')
  for (const g of [...gens].reverse()) {
    const run = g.instance === current ? 'current' : 'earlier'
    console.log(`${String(g.id).padEnd(5)} ${when(g.lastSeenAt).padEnd(24)} ${String(g.agents.length).padEnd(7)} ${run}`)
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * One restore at a time: two concurrent runs would both see the same
 * sessions as "not running" and open each twice. The lock names its owner's
 * pid; it is reclaimed only when that process is gone, and released only by
 * its owner.
 */
export function acquireLock(path: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true })
  const owner = () => {
    try {
      return Number(readFileSync(path, 'utf8')) || null
    } catch {
      return null
    }
  }
  const held = owner()
  if (held !== null && held !== pid && pidAlive(held)) {
    throw new TermbusError('another `termbus restore` is running — wait for it to finish')
  }
  const tmp = `${path}.${pid}`
  writeFileSync(tmp, String(pid))
  try {
    if (held === null) linkSync(tmp, path) // atomic create; EEXIST if someone beat us
    else renameSync(tmp, path) // reclaim from a dead owner
  } catch {
    throw new TermbusError('another `termbus restore` is running — wait for it to finish')
  } finally {
    rmSync(tmp, { force: true })
  }
  if (owner() !== pid) throw new TermbusError('another `termbus restore` is running — wait for it to finish')
  return () => {
    if (owner() === pid) rmSync(path, { force: true })
  }
}

export async function cmdRestore(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      list: { type: 'boolean' },
      generation: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  const store = loadStore(snapshotFile())
  const instance = await terminalInstance()
  if (values.list) return printList(store.generations, instance)

  let gen: Generation | null
  if (values.generation) {
    gen = store.generations.find((g) => g.id === Number(values.generation)) ?? null
    if (!gen) throw new TermbusError(`no snapshot ${values.generation} — see \`termbus restore --list\``)
  } else {
    gen = pickGeneration(store, instance)
    if (!gen) {
      throw new TermbusError(
        store.generations.length === 0
          ? 'no snapshots yet — run `termbus snapshot --install` so there is something to restore next time'
          : 'nothing to restore from before this iTerm2 session started — see `termbus restore --list` and pick one with --generation N',
      )
    }
  }

  const backend = detectBackend()
  const release = values['dry-run'] ? () => {} : acquireLock(join(dirname(snapshotFile()), 'restore.lock'))
  try {
    await runRestore(backend, gen, !!values['dry-run'])
  } finally {
    release()
  }
}

async function runRestore(backend: Backend, gen: Generation, dryRun: boolean): Promise<void> {
  // live = running anywhere on this Mac, found by process, not by pane list
  const live = await liveAgents()
  const plan = planRestore(gen, live.ids, live.uncertain)

  console.log(`snapshot ${gen.id} from ${when(gen.lastSeenAt)}:`)
  for (const s of plan.skipped) console.log(`  skip   ${describe(s.agent)}  (${s.reason})`)
  const lines = new Map<SavedAgent, string>()
  for (const a of plan.windows.flat(2)) {
    const { argv: cmd, dropped } = buildResumeArgv(a.kind, a.command, a.sessionId!)
    lines.set(a, restoreShellLine(a.cwd!, cmd))
    console.log(`  open   ${describe(a)}`)
    console.log(`         $ ${lines.get(a)}${dropped.length ? `   (not carried over: ${dropped.join(' ')})` : ''}`)
  }
  if (lines.size === 0) {
    console.log('nothing to open')
    return
  }
  if (dryRun) return

  if (!backend.createWindow || !backend.createTab || !backend.splitPane) {
    throw new TermbusError(`the ${backend.name} backend cannot create panes`)
  }
  const launchDir = join(dirname(snapshotFile()), 'launch')
  mkdirSync(launchDir, { recursive: true, mode: 0o700 })
  const shell = userInfo().shell || process.env.SHELL || '/bin/zsh'
  const opened: string[] = []
  for (const win of plan.windows) {
    let anchor: string | null = null // a pane in this window, for new tabs
    for (const tab of win) {
      let prev: string | null = null
      for (const a of tab) {
        // the pane EXECUTES this script: no typing into a shell of unknown readiness
        const script = join(launchDir, `${a.sessionId}.sh`)
        writeFileSync(script, launchScript(shell, lines.get(a)!), { mode: 0o700 })
        chmodSync(script, 0o700)
        const command = /\s/.test(script) ? `"${script}"` : script
        const pane: string = prev
          ? await backend.splitPane(prev, command)
          : anchor
            ? await backend.createTab(anchor, command)
            : await backend.createWindow(command)
        anchor ??= pane
        prev = pane
        opened.push(a.sessionId!)
      }
    }
  }
  console.log(`reopened ${opened.length} agent pane${opened.length === 1 ? '' : 's'}`)
  // hold the lock until the agents are visibly running, so a second restore
  // started right now cannot mistake them for missing and open them again
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const now = await liveAgents().catch(() => null)
    if (now && opened.every((id) => now.ids.has(id))) return
    await defaultClock.sleep(1000)
  }
  console.error('some restored agents have not started yet — check their panes before restoring again')
}
