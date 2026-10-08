import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const plistPath = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Run `termbus <args>` at login, restarted if it dies. Returns the log path. */
export async function installLaunchAgent(label: string, args: string[], logName: string): Promise<string> {
  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url))
  const logPath = join(homedir(), '.termbus', logName)
  const program = [process.execPath, cliPath, ...args].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${program}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>
`
  mkdirSync(join(homedir(), '.termbus'), { recursive: true })
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plistPath(label), plist)
  await execFileP('launchctl', ['unload', plistPath(label)]).catch(() => {})
  await execFileP('launchctl', ['load', '-w', plistPath(label)])
  return logPath
}

export async function uninstallLaunchAgent(label: string): Promise<void> {
  await execFileP('launchctl', ['unload', plistPath(label)]).catch(() => {})
  rmSync(plistPath(label), { force: true })
}
