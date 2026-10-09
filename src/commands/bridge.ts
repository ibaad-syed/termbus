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
import { gitConfigRisk, parseExecRequest, runExec } from '../core/exec.js'
import { applyOrgOp, loadOrg, updateOrg, type OrgOp } from '../core/org.js'
import { packageRoot } from './install-skill.js'
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
  '  --uninstall  remove the launchd service\n' +
  '  --allow-exec / --no-exec\n' +
  '               let HQ run commands on this Mac that you approve with a tap (off by default;\n' +
  '               read-only ones like ps / git status run either way)\n' +
  '  --allow-auto-exec / --no-auto-exec\n' +
  '               also let HQ\'s "Full auto" setting run commands without a tap (off by default)'

const CONFIG_FILE = join(homedir(), '.termbus', 'config.json')
const PLIST_LABEL = 'com.termbus.bridge'
const PLIST_FILE = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`)
const execFileAsync = promisify(execFile)

interface BridgeConfig {
  relay?: string
  secret?: string
  /** this Mac's local consent to run commands the user approves in HQ */
  allowExec?: boolean
  /** this Mac's local consent for HQ's "Full auto" commands (implies allowExec) */
  allowAutoExec?: boolean
}

function readConfig(): BridgeConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as BridgeConfig
  } catch {
    return {}
  }
}

function writeConfig(cfg: BridgeConfig): void {
  mkdirSync(join(homedir(), '.termbus'), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

const BRIDGE_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return 'unknown'
  }
})()
/** What this bridge can do — HQ holds back actions an older bridge can't run. */
const BRIDGE_CAPABILITIES = ['spawn', 'exec', 'org']

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
  kind: 'approve' | 'reject' | 'send' | 'rename' | 'answer' | 'spawn' | 'exec' | 'org'
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

/** HQ edits a department (create/delete/rename/add/remove) on this Mac's org. */
export function executeOrg(action: Pick<HqAction, 'payload'>): { status: string; outcome?: string } {
  let op: OrgOp
  try {
    op = JSON.parse(action.payload ?? '') as OrgOp
  } catch {
    return { status: 'failed', outcome: 'org payload is not JSON' }
  }
  if (!['create', 'delete', 'rename', 'add', 'remove'].includes(op?.op)) return { status: 'failed', outcome: 'unknown org op' }
  if (
    (op.op === 'add' || op.op === 'remove') &&
    (!Array.isArray(op.paneIds) || op.paneIds.length > 64 || !op.paneIds.every((x) => typeof x === 'string' && /^[\w-]{1,200}$/.test(x)))
  ) {
    return { status: 'failed', outcome: 'paneIds must be a list of up to 64 pane ids' }
  }
  try {
    const next = updateOrg((org) => applyOrgOp(org, op))
    return { status: 'done', outcome: JSON.stringify(next) }
  } catch (e) {
    return { status: 'failed', outcome: e instanceof Error ? e.message : String(e) }
  }
}

/** Run a command for HQ's conductor (see src/core/exec.ts for the rules). */
export async function executeExec(
  action: Pick<HqAction, 'payload'>,
  consent: { allowExec: boolean; allowAutoExec: boolean },
): Promise<{ status: string; outcome?: string }> {
  const req = parseExecRequest(action.payload, consent)
  if ('error' in req) return { status: 'failed', outcome: req.error }
  if (req.kind === 'argv' && req.argv[0] === 'git') {
    const risky = await gitConfigRisk(req.cwd)
    if (risky) return { status: 'failed', outcome: `not read-only here: this repo's own git config sets ${risky}, which can run programs — needs the user's approval` }
  }
  const result = await runExec(req, userInfo().shell || process.env.SHELL || '/bin/zsh')
  const what = req.kind === 'argv' ? req.argv.join(' ') : `${req.command} (approved: ${req.approvedBy})`
  console.log(`exec in ${req.cwd}: ${what.slice(0, 200)} → exit ${result.exitCode}`)
  return { status: 'done', outcome: JSON.stringify(result) }
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
  if (action.kind === 'org') return executeOrg(action)
  if (action.kind === 'exec') {
    const cfg = readConfig() // fresh: toggles apply without a restart
    return executeExec(action, { allowExec: cfg.allowExec === true, allowAutoExec: cfg.allowAutoExec === true })
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
    // HQ messages are for agents. If the agent exited since HQ last looked,
    // the pane is a shell now and the text would run as a command — refuse.
    if (!isAgentKind(occ.kind)) return { status: 'failed', outcome: 'no agent is running in that pane any more' }
    const { outcome } = await ensureDeliverable(
      { backend, clock: defaultClock, probeOccupant: () => occupantForTty(pane.tty) },
      pane,
      occ,
      'queue',
      { timeoutMs: 0, pollMs: 1000 },
    )
    // one line only: if the agent exits mid-send, a newline would run the first line in the shell
    const text = action.payload.replace(/[\r\n]+/g, ' ')
    const enveloped = `${buildEnvelope({ label: 'hq', kind: 'shell' }, envelopeId())} ${text}`
    // re-check right before typing: the wait above may have spanned a dialog or an exit
    const before = await occupantForTty(pane.tty)
    if (!isAgentKind(before.kind)) return { status: 'failed', outcome: 'no agent is running in that pane any more' }
    if (paneState(before, await backend.readScreen(pane.id)) === 'awaiting-input') {
      return { status: 'failed', outcome: 'the agent is showing a prompt — answer it first' }
    }
    await backend.sendText(pane.id, enveloped, false)
    // Enter goes separately (TUIs treat text+CR as a paste) — and only if no
    // dialog popped up meanwhile, where Enter would answer it.
    await defaultClock.sleep(200)
    const now = await occupantForTty(pane.tty)
    const screen = isAgentKind(now.kind) ? await backend.readScreen(pane.id) : ''
    if (!isAgentKind(now.kind) || paneState(now, screen) === 'awaiting-input') {
      return { status: 'failed', outcome: 'a prompt appeared while sending — the text is in the input box, not submitted' }
    }
    await backend.sendText(pane.id, '\r', false)
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
      'allow-exec': { type: 'boolean' },
      'no-exec': { type: 'boolean' },
      'allow-auto-exec': { type: 'boolean' },
      'no-auto-exec': { type: 'boolean' },
    },
  })
  const saved = readConfig()
  if (values['allow-exec'] || values['no-exec'] || values['allow-auto-exec'] || values['no-auto-exec']) {
    const next = { ...saved }
    if (values['no-exec']) Object.assign(next, { allowExec: false, allowAutoExec: false })
    if (values['allow-exec']) next.allowExec = true
    if (values['no-auto-exec']) next.allowAutoExec = false
    if (values['allow-auto-exec']) Object.assign(next, { allowExec: true, allowAutoExec: true })
    writeConfig(next)
    console.log(
      !next.allowExec
        ? 'Commands from HQ are OFF on this Mac (read-only ones like ps / git status still run). Enable: termbus bridge --allow-exec'
        : next.allowAutoExec
          ? 'Full auto ALLOWED: if HQ\'s Commands setting is "Full auto", the conductor can run any command here without asking. Undo: termbus bridge --no-auto-exec'
          : 'Commands you approve in HQ will run on this Mac (Full auto stays off). Undo: termbus bridge --no-exec',
    )
    return // read fresh before every command — no restart needed
  }
  const relay = (values.relay ?? saved.relay)?.replace(/\/$/, '')
  const secret = values.secret ?? process.env.TERMBUS_BRIDGE_SECRET ?? saved.secret
  if (!relay || !secret) throw new TermbusError(USAGE)

  if (values.save) {
    mkdirSync(join(homedir(), '.termbus'), { recursive: true })
    writeConfig({ ...saved, relay, secret })
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
      writeConfig({ ...saved, relay, secret })
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
  const spawnCtx: SpawnContext = { limiter: SpawnLimiter.persistent(), anchorPaneId: null }
  let execChain: Promise<void> = Promise.resolve()
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
      const org = loadOrg()
      const digest = paneDigest(snaps) + JSON.stringify(org.departments)
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
            org: { departments: org.departments.map((d) => ({ name: d.name, members: d.members })) },
            bridge: { version: BRIDGE_VERSION, capabilities: BRIDGE_CAPABILITIES },
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
        const report = async (action: HqAction, result: { status: string; outcome?: string }) => {
          console.log(`action #${action.id} ${action.kind} → ${action.paneLabel ?? '-'}: ${result.status}${result.outcome && action.kind !== 'exec' ? ` (${result.outcome})` : ''}`)
          const posted = await api(relay, secret, '/api/bridge/result', {
            method: 'POST',
            body: JSON.stringify({ actionId: action.id, ...result }),
          }).catch(() => null)
          if (!posted?.ok) console.error(`result for #${action.id} not accepted (${posted?.status ?? 'network'}) — action stays claimed on the relay`)
        }
        for (const action of actions) {
          cadence.activity(Date.now()) // the user is interacting: keep polling fast
          if (action.kind === 'exec') {
            // commands can take minutes: run them one at a time OFF the loop,
            // so syncs, heartbeats and approvals keep flowing meanwhile
            execChain = execChain.then(async () => {
              const result = await executeAction(backend, action, feeder, spawnCtx).catch((e: unknown) => ({
                status: 'failed',
                outcome: e instanceof Error ? e.message : String(e),
              }))
              await report(action, result)
            })
            continue
          }
          const result = await executeAction(backend, action, feeder, spawnCtx).catch((e: unknown) => ({
            status: 'failed',
            outcome: e instanceof Error ? e.message : String(e),
          }))
          if (action.kind === 'send' && result.status === 'done') {
            awaitingReply.set(action.paneId, { label: action.paneLabel, since: Date.now(), sawBusy: false })
          }
          await report(action, result)
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
