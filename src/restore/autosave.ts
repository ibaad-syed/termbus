import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLaunchAgent } from '../core/launchd.js'

export const SNAPSHOT_LABEL = 'com.termbus.snapshot'
export const SNAPSHOT_ARGS = ['snapshot', '--watch', '--interval', '15']

/** Ordinary commands: running one of these may set up background snapshots. */
const SETUP_ON = new Set(['list', 'check', 'send', 'ask', 'watch', 'bridge', 'whoami', 'install-skill', 'broadcast', 'dept', 'department'])

const stateFile = (home: string) => join(home, '.termbus', 'autosave.json')

export interface AutosaveState {
  status: 'on' | 'off'
  since: number
}

export function readAutosaveState(home: string = homedir()): AutosaveState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(home), 'utf8')) as AutosaveState
    return s.status === 'on' || s.status === 'off' ? s : null
  } catch {
    return null
  }
}

export function writeAutosaveState(status: AutosaveState['status'], home: string = homedir()): void {
  mkdirSync(dirname(stateFile(home)), { recursive: true })
  writeFileSync(stateFile(home), JSON.stringify({ status, since: Date.now() }))
}

/**
 * Background snapshots are on by default: the first termbus command on a
 * machine installs them once. An explicit `snapshot --uninstall` records
 * "off" and is respected forever. One-off runs (npx, CI) never install a
 * service that would point at a temporary copy.
 */
export function shouldAutoInstall(ctx: {
  command: string | undefined
  args?: string[]
  platform: string
  env: Record<string, string | undefined>
  state: AutosaveState | null
  cliPath: string
  /** the installed service's plist, if any */
  plist?: string | null
  /** does a path exist (for checking the plist's targets) */
  exists?: (path: string) => boolean
}): 'install' | 'repair' | null {
  if (!ctx.command || !SETUP_ON.has(ctx.command)) return null
  if (ctx.args?.some((a) => a === '--help' || a === '-h')) return null
  if (ctx.platform !== 'darwin') return null
  if (ctx.env.CI || ctx.env.TERMBUS_NO_AUTOSAVE) return null
  // only an installed package is a durable home for a login service — not a
  // git checkout (moved/deleted later) and not an npx temp copy
  if (!/[/\\]node_modules[/\\]termbus[/\\]/.test(ctx.cliPath) || /[/\\]_npx[/\\]/.test(ctx.cliPath)) return null
  if (!ctx.state) return 'install'
  if (ctx.state.status !== 'on' || !ctx.plist || !ctx.exists) return null
  // on, but the service points at files that are gone (node version switch,
  // reinstall elsewhere): re-point it at this install
  const targets = [...ctx.plist.matchAll(/<string>(\/[^<]+)<\/string>/g)].map((m) => m[1]).filter((t) => !t.endsWith('.log'))
  return targets.some((t) => !ctx.exists!(t)) ? 'repair' : null
}

export async function ensureAutosave(
  command: string | undefined,
  args: string[] = [],
  home: string = homedir(),
): Promise<void> {
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
  let plist: string | null = null
  try {
    plist = readFileSync(join(home, 'Library', 'LaunchAgents', `${SNAPSHOT_LABEL}.plist`), 'utf8')
  } catch {
    // not installed
  }
  const action = shouldAutoInstall({
    command,
    args,
    platform: process.platform,
    env: process.env,
    state: readAutosaveState(home),
    cliPath,
    plist,
    exists: existsSync,
  })
  if (!action) return
  try {
    await installLaunchAgent(SNAPSHOT_LABEL, SNAPSHOT_ARGS, 'snapshot.log')
    writeAutosaveState('on', home)
    if (action === 'repair') return
    // stderr: never corrupt a command's stdout (list --json)
    console.error(
      'termbus: now remembering your agent panes in the background, so `termbus restore` can bring them back after a restart (turn off: termbus snapshot --uninstall)',
    )
  } catch {
    // launchd unavailable; try again next run rather than nag
  }
}
