import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { defaultClock } from '../core/ask.js'
import { ensureDeliverable, isAgentKind, paneState } from '../core/delivery.js'
import { Cadence, paneDigest } from '../core/cadence.js'
import { parseSpawnRequest, SPAWN_LIMIT, SPAWN_WINDOW_MS, SpawnLimiter, spawnShellLine } from '../core/spawn.js'
import { launchScript } from '../restore/resume-command.js'
import { buildEnvelope, envelopeId } from '../core/envelope.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { looksLikeQuestionDialog } from '../core/idle.js'
import { executeScreenAnswer, parseClaudeQuestionScreen, SCREEN_CALL_PREFIX, type ScreenAnswer } from '../core/claude-question-screen.js'
import { planAnswerSteps, runAnswerSteps, validateAnswers, verifyFreshDialog, type QuestionAnswer } from '../core/question.js'
import { applySnapshots, diffStates, type WatchSnapshot } from '../core/watch.js'
import { TranscriptFeeder } from './bridge-transcripts.js'
import type { Backend, Pane } from '../core/types.js'

const USAGE =
  'usage: termbus bridge [--relay <url> --secret <s>] [--save] [--install|--uninstall] [--interval S]\n' +
  'Connects this Mac to a termbus-hq deployment (outbound only).\n' +
  '  --save       remember relay+secret in ~/.termbus/config.json (then flags are optional)\n' +
  '  --install    run persistently via launchd (auto-start on login, auto-restart)\n' +
  '  --uninstall  remove the launchd service'

const CONFIG_FILE = join(homedir(), '.termbus', 'config.json')
const PLIST_LABEL = 'com.termbus.bridge'
const PLIST_FILE = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const execFileAsync = promisify(execFile)

function readConfig(): { relay?: string; secret?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { relay?: string; secret?: string }
  } catch {
    return {}
  }
}

const FOOTER_LINES = 15 // prompt fingerprints stay footer-scoped
const PEEK_LINES = 60 // terminal view in HQ

export function promptFingerprint(screen: string): string {
  const tail = screen.split('\n').slice(-FOOTER_LINES).join('\n').trim()
  return createHash('sha256').update(tail).digest('hex').slice(0, 24)
}

interface HqAction {
  id: number
  paneId: string
  paneLabel: string
  kind: 'approve' | 'reject' | 'send' | 'rename' | 'answer' | 'spawn'
  payload: string | null
  promptFingerprint: string | null
}

async function api(base: string, secret: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function snapshotPanes(backend: Backend, panes?: Pane[]): Promise<Array<WatchSnapshot & { occupant: string; screen?: string }>> {
  panes = panes ?? (await backend.listPanes())
  const out: Array<WatchSnapshot & { occupant: string; screen?: string }> = []
  for (const p of panes.filter((x: Pane) => !x.isSelf)) {
    try {
      const occ = await occupantForTty(p.tty)
      const screen = isAgentKind(occ.kind) ? await backend.readScreen(p.id) : ''
      const state = paneState(occ, screen)
      const snap: WatchSnapshot & { occupant: string; screen?: string } = {
        id: p.id,
        label: p.label,
        title: p.title,
        state,
        occupant: occ.kind,
      }
      // agent panes ship a footer preview so HQ can render a quick peek;
      // shells/commands never leak screen content
      if (isAgentKind(occ.kind)) snap.screen = screen.split('\n').slice(-PEEK_LINES).join('\n')
      out.push(snap)
    } catch {
      // pane closed mid-scan
    }
  }
  return out
}

/** True when an agent pane's screen is an interactive question dialog. */
function isQuestionScreen(occupant: string, screen: string | undefined): boolean {
  return !!screen && (occupant === 'claude' || occupant === 'codex') && looksLikeQuestionDialog(occupant, screen)
}

/**
 * kind=answer: payload {callId, answers[]}. The questions themselves come from
 * this Mac's own transcript (never from the relay), the dialog on screen must
 * be exactly that question in its untouched state, and every keystroke step is
 * screen-verified — anything off returns 'stale' with nothing typed.
 */
export async function executeAnswer(
  backend: Backend,
  pane: Pane,
  occKind: string,
  action: Pick<HqAction, 'payload'>,
  feeder: Pick<TranscriptFeeder, 'openQuestion' | 'linkedPane'> | null,
  clock = defaultClock,
): Promise<{ status: string; outcome?: string }> {
  let payload: { callId?: unknown; answers?: unknown }
  try {
    payload = JSON.parse(action.payload ?? '')
  } catch {
    return { status: 'failed', outcome: 'malformed answer payload' }
  }
  if (typeof payload.callId !== 'string') return { status: 'failed', outcome: 'answer has no question id' }
  if (!feeder) return { status: 'failed', outcome: 'transcripts are off on this bridge — cannot verify the question' }
  const q = feeder.openQuestion(payload.callId)
  if (!q) return { status: 'stale', outcome: 'that question is no longer open' }
  if (occKind !== q.agent) return { status: 'stale', outcome: `pane is running ${occKind}, the question came from ${q.agent}` }
  const linked = feeder.linkedPane(q.sessionId)
  if (linked && linked !== pane.id) return { status: 'stale', outcome: 'the question belongs to a different pane' }
  const answers = payload.answers as QuestionAnswer[]
  const invalid = validateAnswers(q.agent, q.items, answers, q.allowOther)
  if (invalid) return { status: 'failed', outcome: invalid }
  const screen = await backend.readScreen(pane.id)
  const mismatch = verifyFreshDialog(q.agent, screen, q.items)
  if (mismatch) return { status: 'stale', outcome: mismatch }
  return runAnswerSteps(backend, pane.id, planAnswerSteps(q.agent, q.items, answers), clock)
}

/** State for `spawn` actions: the rate limit, and the window new agents
 *  open in (one window of tabs, not a window per agent). */
export interface SpawnContext {
  limiter: SpawnLimiter
  anchorPaneId: string | null
}

export async function executeSpawn(
  backend: Backend,
  action: Pick<HqAction, 'id' | 'payload'>,
  ctx: SpawnContext,
  now = Date.now(),
): Promise<{ status: string; outcome?: string }> {
  const req = parseSpawnRequest(action.payload)
  if ('error' in req) return { status: 'failed', outcome: req.error }
  if (!backend.createWindow || !backend.createTab) return { status: 'failed', outcome: `the ${backend.name} backend cannot create panes` }
  if (!ctx.limiter.take(now)) return { status: 'failed', outcome: `spawn limit reached (${SPAWN_LIMIT} per ${SPAWN_WINDOW_MS / 60_000} min)` }
  const dir = join(homedir(), '.termbus', 'launch')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const script = join(dir, `spawn-${action.id}.sh`)
  const shell = userInfo().shell || process.env.SHELL || '/bin/zsh'
  writeFileSync(script, launchScript(shell, spawnShellLine(req)), { mode: 0o700 })
  chmodSync(script, 0o700)
  const command = /\s/.test(script) ? `"${script}"` : script
  const anchorAlive = ctx.anchorPaneId !== null && (await backend.listPanes()).some((p) => p.id === ctx.anchorPaneId)
  const paneId = anchorAlive ? await backend.createTab(ctx.anchorPaneId!, { command }) : await backend.createWindow({ command })
  ctx.anchorPaneId = paneId
  if (req.name && backend.setPaneName) await backend.setPaneName(paneId, req.name).catch(() => {})
  return { status: 'done', outcome: paneId }
}

async function executeAction(
  backend: Backend,
  action: HqAction,
  feeder: TranscriptFeeder | null = null,
  spawnCtx: SpawnContext | null = null,
): Promise<{ status: string; outcome?: string }> {
  if (action.kind === 'spawn') {
    return spawnCtx ? executeSpawn(backend, action, spawnCtx) : { status: 'failed', outcome: 'spawning is not enabled' }
  }
  const panes = await backend.listPanes()
  const pane = panes.find((p) => p.id === action.paneId)
  if (!pane) return { status: 'failed', outcome: 'pane no longer exists' }
  const occ = await occupantForTty(pane.tty)

  if (action.kind === 'approve' || action.kind === 'reject') {
    // Verify the SAME prompt is still on screen before touching the pane —
    // an Enter meant for prompt A must never land on prompt B.
    const screen = await backend.readScreen(pane.id)
    if (paneState(occ, screen) !== 'awaiting-input') {
      return { status: 'stale', outcome: 'pane is no longer at a prompt' }
    }
    if (!action.promptFingerprint) {
      return { status: 'failed', outcome: 'action has no prompt fingerprint — refusing to type blind' }
    }
    if (promptFingerprint(screen) !== action.promptFingerprint) {
      return { status: 'stale', outcome: 'a different prompt is showing now' }
    }
    await backend.sendText(pane.id, action.kind === 'approve' ? '\r' : '\u001b', false)
    return { status: 'done' }
  }

  if (action.kind === 'answer') {
    // screen-built Claude cards carry `screen:<step fingerprint>`; the step on
    // screen must still be exactly that one (checked inside)
    let parsed: { callId?: unknown; answer?: unknown } | null = null
    try {
      parsed = JSON.parse(action.payload ?? '')
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed.callId === 'string' && parsed.callId.startsWith(SCREEN_CALL_PREFIX)) {
      if (occ.kind !== 'claude') return { status: 'stale', outcome: 'pane is no longer running claude' }
      const answer = (parsed.answer && typeof parsed.answer === 'object' ? parsed.answer : {}) as ScreenAnswer
      return executeScreenAnswer(backend, pane.id, parsed.callId, answer, defaultClock)
    }
    return executeAnswer(backend, pane, occ.kind, action, feeder)
  }

  if (action.kind === 'send') {
    if (!action.payload) return { status: 'failed', outcome: 'empty payload' }
    const { outcome } = await ensureDeliverable(
      { backend, clock: defaultClock, probeOccupant: () => occupantForTty(pane.tty) },
      pane,
      occ,
      'queue',
      { timeoutMs: 0, pollMs: 1000 },
    )
    const enveloped = isAgentKind(occ.kind)
      ? `${buildEnvelope({ label: 'hq', kind: 'shell' }, envelopeId())} ${action.payload}`
      : action.payload
    await backend.sendText(pane.id, enveloped, true)
    return { status: 'done', outcome: outcome === 'queued' ? 'queued (pane was busy)' : 'delivered' }
  }

  if (action.kind === 'rename') {
    if (!action.payload) return { status: 'failed', outcome: 'empty name' }
    if (!backend.setPaneName) return { status: 'failed', outcome: 'backend cannot rename panes' }
    await backend.setPaneName(pane.id, action.payload)
    return { status: 'done', outcome: 'pane renamed' }
  }

  return { status: 'failed', outcome: `unknown action kind ${action.kind}` }
}

export async function cmdBridge(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: 'string' },
      secret: { type: 'string' },
      interval: { type: 'string' },
      save: { type: 'boolean' },
      install: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      'no-transcripts': { type: 'boolean' },
    },
  })
  const saved = readConfig()
  const relay = (values.relay ?? saved.relay)?.replace(/\/$/, '')
  const secret = values.secret ?? process.env.TERMBUS_BRIDGE_SECRET ?? saved.secret
  if (!relay || !secret) throw new TermbusError(USAGE)

  if (values.save) {
    mkdirSync(join(homedir(), '.termbus'), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ relay, secret }, null, 2), { mode: 0o600 })
    console.log(`saved to ${CONFIG_FILE} — future runs can use plain \`termbus bridge\``)
  }

  if (values.uninstall) {
    await execFileAsync('launchctl', ['unload', PLIST_FILE]).catch(() => {})
    writeFileSync(PLIST_FILE, '') // truncate before unlink-less removal
    await execFileAsync('rm', ['-f', PLIST_FILE])
    console.log('launchd service removed')
    return
  }

  if (values.install) {
    if (!values.save) {
      mkdirSync(join(homedir(), '.termbus'), { recursive: true })
      writeFileSync(CONFIG_FILE, JSON.stringify({ relay, secret }, null, 2), { mode: 0o600 })
    }
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
    const logPath = join(homedir(), '.termbus', 'bridge.log')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>bridge</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict></plist>
`
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(PLIST_FILE, plist)
    await execFileAsync('launchctl', ['unload', PLIST_FILE]).catch(() => {})
    await execFileAsync('launchctl', ['load', '-w', PLIST_FILE])
    console.log(`installed + started: launchd service ${PLIST_LABEL} (log: ${logPath})`)
    console.log('it now runs at login and restarts automatically — Ctrl-C not needed')
    return
  }
  if (relay.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(relay)) {
    throw new TermbusError('refusing plain http to a non-local relay — the bridge secret would travel unencrypted')
  }
  const intervalMs = (values.interval ? Number(values.interval) : 1) * 1000
  const backend = detectBackend()

  const feeder = values['no-transcripts']
    ? null
    : new TranscriptFeeder((path, init) => api(relay, secret, path, init))
  console.log(`bridge → ${relay}${feeder ? ' (streaming transcripts)' : ''} (Ctrl-C to stop)`)
  let prev = new Map<string, WatchSnapshot>()
  let failures = 0
  // panes we delivered a send to and owe HQ the agent's reply
  const awaitingReply = new Map<string, { label: string; since: number; sawBusy: boolean }>()
  const cadence = new Cadence()
  const spawnCtx: SpawnContext = { limiter: new SpawnLimiter(), anchorPaneId: null }
  for (;;) {
    try {
      const allPanes = await backend.listPanes()
      const snaps = await snapshotPanes(backend, allPanes)
      const events = diffStates(prev, snaps).map((ev) => {
        const snap = snaps.find((s) => s.id === ev.id)
        return {
          paneId: ev.id,
          label: ev.label,
          title: ev.title,
          from: ev.from,
          to: ev.to,
          screen: snap?.screen,
          promptFingerprint: snap?.screen ? promptFingerprint(snap.screen) : undefined,
          // a question dialog is answered from its question card, not approve/reject
          ...(ev.to === 'awaiting-input' && snap && isQuestionScreen(snap.occupant, snap.screen) ? { dialog: 'question' } : {}),
        }
      })
      const now = Date.now()
      cadence.observe(now, snaps)
      const digest = paneDigest(snaps)
      if (cadence.shouldSync(now, digest, events.length > 0)) {
        const sync = await api(relay, secret, '/api/bridge/sync', {
          method: 'POST',
          body: JSON.stringify({
            panes: snaps.map((s) => ({
              paneId: s.id,
              label: s.label,
              title: s.title,
              occupant: s.occupant,
              state: s.state,
              screen: s.screen,
            })),
            events,
          }),
        })
        if (!sync.ok) throw new Error(`sync ${sync.status}`)
        cadence.synced(now, digest)
        prev = applySnapshots(prev, snaps) // only after the relay has the events — a failed POST retries them
      }

      if (feeder) {
        await feeder.tick(allPanes)
        for (const ev of events) {
          if (ev.to === 'awaiting-input' && ev.screen && ev.promptFingerprint && !('dialog' in ev)) {
            let syn = feeder.syntheticPermissionEvent(ev.paneId, ev.screen, ev.promptFingerprint)
            if (!syn) {
              // the pane may be seconds old — link now, not at the next cadence
              await feeder.refreshLinks(allPanes)
              syn = feeder.syntheticPermissionEvent(ev.paneId, ev.screen, ev.promptFingerprint)
            }
            if (syn) await feeder.postSynthetic(syn)
          }
        }
        // Claude question dialogs → screen-built cards, one per visible step
        for (const snap of snaps) {
          if (snap.occupant !== 'claude') continue
          const parsed = snap.screen ? parseClaudeQuestionScreen(snap.screen) : null
          let posts = feeder.screenQuestionEvents(snap.id, parsed)
          if (parsed && !feeder.hasScreenCard(snap.id)) {
            await feeder.refreshLinks(allPanes) // the pane may be seconds old
            posts = [...posts, ...feeder.screenQuestionEvents(snap.id, parsed)]
          }
          for (const post of posts) {
            if (!(await feeder.postSynthetic(post))) feeder.forgetScreenCard(snap.id)
          }
        }
      }

      for (const [paneId, wait] of awaitingReply) {
        const snap = snaps.find((x) => x.id === paneId)
        if (!snap || Date.now() - wait.since > 300_000) {
          awaitingReply.delete(paneId)
          continue
        }
        if (snap.state === 'busy') wait.sawBusy = true
        if (snap.state === 'idle' && (wait.sawBusy || Date.now() - wait.since > 15_000)) {
          awaitingReply.delete(paneId)
          if (snap.screen) {
            await api(relay, secret, '/api/bridge/message', {
              method: 'POST',
              body: JSON.stringify({ paneLabel: wait.label, body: snap.screen }),
            }).catch(() => {})
          }
        }
      }

      if (awaitingReply.size > 0) cadence.activity(Date.now()) // a reply is on its way
      const work = cadence.shouldPollWork(Date.now()) ? await api(relay, secret, '/api/bridge/work') : null
      if (work) cadence.polledWork(Date.now())
      if (work?.ok) {
        const { actions, hot } = (await work.json()) as { actions: HqAction[]; hot?: boolean }
        // someone has HQ open (a live chat): answer their messages within a second
        if (hot) cadence.activity(Date.now())
        for (const action of actions) {
          const result = await executeAction(backend, action, feeder, spawnCtx).catch((e: unknown) => ({
            status: 'failed',
            outcome: e instanceof Error ? e.message : String(e),
          }))
          cadence.activity(Date.now()) // the user is interacting: keep polling fast
          console.log(`action #${action.id} ${action.kind} → ${action.paneLabel}: ${result.status}${result.outcome ? ` (${result.outcome})` : ''}`)
          if (action.kind === 'send' && result.status === 'done') {
            awaitingReply.set(action.paneId, { label: action.paneLabel, since: Date.now(), sawBusy: false })
          }
          const posted = await api(relay, secret, '/api/bridge/result', {
            method: 'POST',
            body: JSON.stringify({ actionId: action.id, ...result }),
          })
          if (!posted.ok) console.error(`result for #${action.id} not accepted (${posted.status}) — action stays claimed on the relay`)
        }
      }
      failures = 0
    } catch (err) {
      failures++
      console.error(`bridge error (${failures}): ${err instanceof Error ? err.message : String(err)}`)
      if (failures > 5) await defaultClock.sleep(Math.min(60_000, failures * 5000)) // back off, keep trying
    }
    await defaultClock.sleep(intervalMs)
  }
}
