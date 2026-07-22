import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { ensureDeliverable, isAgentKind, paneState } from '../core/delivery.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { resolveTarget } from '../core/resolve.js'
import { applySnapshots, diffStates, type WatchSnapshot } from '../core/watch.js'
import type { Backend, Pane } from '../core/types.js'

const execFileP = promisify(execFile)

const USAGE =
  'usage: termbus watch [target ...] [--interval S] [--notify] [--push <target>] [--json] [--once]\n' +
  'No targets = watch every agent pane. Runs until Ctrl-C; give it its own pane.'

async function snapshot(backend: Backend, pane: Pane): Promise<WatchSnapshot | null> {
  try {
    const occ = await occupantForTty(pane.tty)
    const screen = isAgentKind(occ.kind) ? await backend.readScreen(pane.id) : ''
    return { id: pane.id, label: pane.label, title: pane.title, state: paneState(occ, screen) }
  } catch {
    return null // pane vanished mid-poll; diffStates reports it next tick
  }
}

async function notify(text: string): Promise<void> {
  const esc = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await execFileP('osascript', ['-e', `display notification "${esc}" with title "termbus"`]).catch(() => {})
}

async function push(backend: Backend, panes: Pane[], target: string, message: string): Promise<string> {
  const pane = resolveTarget(panes, target)
  const occ = await occupantForTty(pane.tty)
  const screen = await backend.readScreen(pane.id)
  if (paneState(occ, screen) === 'awaiting-input') {
    return `push skipped: supervisor ${pane.label} is itself awaiting input`
  }
  const { outcome } = await ensureDeliverable(
    { backend, clock: defaultClock },
    pane,
    occ,
    'queue',
    { timeoutMs: 0, pollMs: 1000 },
  )
  await backend.sendText(pane.id, message, true)
  return outcome === 'queued' ? `pushed to ${pane.label} (queued)` : `pushed to ${pane.label}`
}

export async function cmdWatch(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      interval: { type: 'string' },
      notify: { type: 'boolean' },
      push: { type: 'string' },
      json: { type: 'boolean' },
      once: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  const intervalMs = (values.interval ? Number(values.interval) : 2) * 1000
  if (!Number.isFinite(intervalMs) || intervalMs < 500) throw new TermbusError(USAGE)
  const backend = detectBackend()

  const emit = (line: object | string): void => {
    if (values.json) console.log(JSON.stringify(typeof line === 'string' ? { message: line } : line))
    else if (typeof line === 'string') console.log(line)
  }

  let prev = new Map<string, WatchSnapshot>()
  let first = true
  for (;;) {
    const panes = await backend.listPanes()
    let watched: Pane[]
    if (positionals.length > 0) {
      watched = positionals.flatMap((t) => {
        try {
          return [resolveTarget(panes, t)]
        } catch {
          return [] // disappeared targets are reported via diffStates
        }
      })
    } else {
      const withOcc = await Promise.all(
        panes.filter((p) => !p.isSelf).map(async (p) => ({ p, occ: await occupantForTty(p.tty) })),
      )
      watched = withOcc.filter(({ occ }) => isAgentKind(occ.kind)).map(({ p }) => p)
    }

    const snaps = (await Promise.all(watched.map((p) => snapshot(backend, p)))).filter(
      (s): s is WatchSnapshot => s !== null,
    )
    const events = diffStates(prev, snaps)
    prev = applySnapshots(prev, snaps)

    for (const ev of events) {
      const ts = new Date().toTimeString().slice(0, 8)
      if (first && ev.from === null) {
        emit(values.json ? { ts, ...ev } : `${ts} watching ${ev.label} (${ev.title}) — ${ev.to}`)
        continue
      }
      const line =
        ev.to === null
          ? `${ts} ${ev.label} (${ev.title}) pane closed`
          : `${ts} ${ev.label} (${ev.title}) ${ev.from ?? 'new'} → ${ev.to}`
      emit(values.json ? { ts, ...ev } : line)

      if (ev.to === 'awaiting-input') {
        const alert = `[termbus watch] ${ev.label} (${ev.title}) needs attention: stopped at a prompt. See it: termbus check ${ev.label} — approve: termbus send ${ev.label} --raw '\\r'`
        if (values.notify) await notify(`${ev.label} is awaiting input`)
        if (values.push) {
          const res = await push(backend, panes, values.push, alert).catch(
            (e: unknown) => `push failed: ${e instanceof Error ? e.message : String(e)}`,
          )
          emit(values.json ? { ts, push: res } : `${ts} ${res}`)
        }
      }
    }
    first = false
    if (values.once) return
    await defaultClock.sleep(intervalMs)
  }
}
