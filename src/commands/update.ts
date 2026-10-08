import { execFile, spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { TermbusError } from '../core/errors.js'
import { packageRoot } from './install-skill.js'

const execFileP = promisify(execFile)

/** launchd services termbus may have installed; restarted to pick up new code. */
const SERVICES = ['com.termbus.snapshot', 'com.termbus.bridge']

export async function cmdUpdate(argv: string[] = []): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: termbus update\nInstalls the latest termbus from npm, refreshes the Claude Code skill if installed,\nand restarts termbus background services so they run the new version.')
    return
  }
  if (argv.length > 0) throw new TermbusError(`termbus update takes no arguments (got: ${argv.join(' ')})`)
  const { stdout } = await execFileP('npm', ['root', '-g']).catch(() => ({ stdout: '' }))
  const globalRoot = stdout.trim()
  const root = realpathSync(packageRoot())
  if (!globalRoot || !root.startsWith(realpathSync(globalRoot))) {
    throw new TermbusError(
      `this termbus runs from ${root}, not a global npm install — update it there (e.g. git pull && npm run build)`,
    )
  }
  console.log('installing the latest termbus…')
  const npm = spawnSync('npm', ['install', '-g', 'termbus@latest'], { stdio: 'inherit' })
  if (npm.status !== 0) throw new TermbusError('npm install failed (see above)')

  // the new code is on disk; run its setup with the NEW binary
  const problems: string[] = []
  if (existsSync(join(homedir(), '.claude', 'skills', 'termbus'))) {
    const skill = spawnSync('termbus', ['install-skill'], { stdio: 'inherit' })
    if (skill.status !== 0) problems.push('refreshing the Claude Code skill failed — run `termbus install-skill`')
  }
  const uid = process.getuid?.()
  for (const label of SERVICES) {
    if (!existsSync(join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`))) continue
    try {
      await execFileP('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`])
      console.log(`restarted ${label}`)
    } catch (e) {
      problems.push(`could not restart ${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (problems.length > 0) throw new TermbusError(`updated, but:\n  ${problems.join('\n  ')}`)
  const v = spawnSync('termbus', ['--version'], { encoding: 'utf8' })
  console.log(`done${v.stdout ? ` — termbus ${v.stdout.trim()}` : ''}`)
}
