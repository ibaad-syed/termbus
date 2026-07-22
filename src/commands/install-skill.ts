import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TermbusError } from '../core/errors.js'

export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new TermbusError('could not locate termbus package root')
    dir = parent
  }
  return dir
}

export function installSkill(home: string = homedir()): string {
  const src = join(packageRoot(), 'skills', 'claude', 'termbus')
  if (!existsSync(src)) throw new TermbusError(`bundled skill not found at ${src}`)
  const dest = join(home, '.claude', 'skills', 'termbus')
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })
  return dest
}

export async function cmdInstallSkill(): Promise<void> {
  const dest = installSkill()
  console.log(`installed Claude Code skill to ${dest}`)
  console.log('New Claude Code sessions can now use termbus. Codex: paste skills/claude/termbus/SKILL.md into your AGENTS.md.')
}
