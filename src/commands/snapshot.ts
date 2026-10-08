import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { TermbusError } from '../core/errors.js'
import { installLaunchAgent, uninstallLaunchAgent } from '../core/launchd.js'
import { SNAPSHOT_ARGS, SNAPSHOT_LABEL, writeAutosaveState } from '../restore/autosave.js'
import { captureAgents, liveAgents, snapshotFile, terminalInstance } from '../restore/capture.js'
import { planRestore } from '../restore/plan.js'
import { loadStore, pickGeneration, recordGeneration, saveStore } from '../restore/store.js'
import type { SnapshotStore } from '../restore/types.js'
import type { LiveAgents } from '../restore/capture.js'

const execFileP = promisify(execFile)
const LABEL = SNAPSHOT_LABEL
const USAGE =
  'usage: termbus snapshot [--watch] [--interval S] [--install|--uninstall]\n' +
  'Remembers which agent panes are open and which conversation each runs,\n' +
  'so `termbus restore` can bring them back after a restart.\n' +
  '  --watch      keep snapshotting every --interval seconds (default 15)\n' +
  '  --install    run --watch in the background at login (launchd)\n' +
  '  --uninstall  remove the background service and keep it off\n' +
  'Background snapshots turn on by themselves the first time termbus runs.'

/**
 * How many agents from before the terminal restarted are not running now.
 * Only meaningful on the first snapshot of a new terminal instance (before it
 * is recorded); 0 otherwise.
 */
export function isNewInstance(store: SnapshotStore, instance: string): boolean {
  const last = store.generations[store.generations.length - 1]
  return !!last && last.instance !== instance
}

export function agentsToRestore(store: SnapshotStore, instance: string, live: LiveAgents): number {
  if (!isNewInstance(store, instance)) return 0
  const gen = pickGeneration(store, instance)
  return gen ? planRestore(gen, live.ids, live.uncertain).windows.flat(2).length : 0
}

async function notify(message: string): Promise<void> {
  // Notification Center via standard additions — does not touch iTerm2
  const script = `display notification ${JSON.stringify(message)} with title "termbus"`
  await execFileP('osascript', ['-e', script]).catch(() => {})
}

/**
 * One snapshot. Returns the number of agents seen, or null if iTerm2 is not
 * running (or quit/restarted mid-capture — that capture is discarded).
 * `notifyRestart`: on the first snapshot of a new iTerm2 run, post a
 * notification if agents from before are missing.
 */
async function takeSnapshot(notifyRestart: boolean): Promise<number | null> {
  const instance = await terminalInstance()
  if (!instance) return null // never launch iTerm2 just to look at it
  const agents = await captureAgents(detectBackend())
  if (!agents || (await terminalInstance()) !== instance) return null
  const path = snapshotFile()
  const store = loadStore(path)
  if (notifyRestart && isNewInstance(store, instance)) {
    const n = agentsToRestore(store, instance, await liveAgents())
    if (n > 0) await notify(`${n} agent${n === 1 ? ' was' : 's were'} open before iTerm restarted. Run: termbus restore`)
  }
  saveStore(path, recordGeneration(store, { instance, agents, now: Date.now() }))
  return agents.length
}

export async function cmdSnapshot(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      watch: { type: 'boolean' },
      interval: { type: 'string' },
      install: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return
  }
  const interval = values.interval ? Number(values.interval) : 15
  if (!Number.isFinite(interval) || interval < 2) throw new TermbusError('--interval must be a number of seconds ≥ 2')

  if (values.uninstall) {
    await uninstallLaunchAgent(LABEL)
    writeAutosaveState('off')
    console.log('background snapshots stopped (launchd service removed)')
    return
  }
  if (values.install) {
    const args = values.interval ? ['snapshot', '--watch', '--interval', String(interval)] : SNAPSHOT_ARGS
    const log = await installLaunchAgent(LABEL, args, 'snapshot.log')
    writeAutosaveState('on')
    console.log(`background snapshots every ${interval}s, starting at login (log: ${log})`)
    console.log('after a restart, run: termbus restore')
    return
  }
  if (!values.watch) {
    const n = await takeSnapshot(false)
    if (n === null) throw new TermbusError('iTerm2 is not running — nothing to snapshot')
    console.log(`saved ${n} agent pane${n === 1 ? '' : 's'} → ${snapshotFile()}`)
    return
  }
  console.log(`snapshotting every ${interval}s → ${snapshotFile()} (Ctrl-C to stop)`)
  for (;;) {
    try {
      await takeSnapshot(true)
    } catch (err) {
      console.error(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    await defaultClock.sleep(interval * 1000)
  }
}
