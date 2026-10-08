import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAutosaveState, shouldAutoInstall, writeAutosaveState } from '../src/restore/autosave.js'

const base = {
  command: 'list',
  platform: 'darwin',
  env: {},
  state: null,
  cliPath: '/usr/local/lib/node_modules/termbus/dist/cli.js',
}

describe('shouldAutoInstall', () => {
  it('installs on the first ordinary command on a Mac', () => {
    expect(shouldAutoInstall(base)).toBe('install')
  })
  it('never twice, and never after the user turned it off', () => {
    expect(shouldAutoInstall({ ...base, state: { status: 'on', since: 1 } })).toBeNull()
    expect(shouldAutoInstall({ ...base, state: { status: 'off', since: 1 } })).toBeNull()
  })
  it('not from snapshot/restore/update/help, unknown commands, --help, or no command', () => {
    expect(shouldAutoInstall({ ...base, args: ['--help'] })).toBeNull()
    for (const command of ['snapshot', 'restore', 'update', '--update', 'help', 'bogus', '--version', undefined]) {
      expect(shouldAutoInstall({ ...base, command })).toBeNull()
    }
  })
  it('not off macOS, in CI, when opted out, or from an npx temp copy', () => {
    expect(shouldAutoInstall({ ...base, platform: 'linux' })).toBeNull()
    expect(shouldAutoInstall({ ...base, env: { CI: 'true' } })).toBeNull()
    expect(shouldAutoInstall({ ...base, env: { TERMBUS_NO_AUTOSAVE: '1' } })).toBeNull()
    expect(shouldAutoInstall({ ...base, cliPath: '/Users/x/.npm/_npx/abc/node_modules/termbus/dist/cli.js' })).toBeNull()
  })
})

describe('shouldAutoInstall: durable installs and repair', () => {
  it('never from a git checkout (the service would break when it moves)', () => {
    expect(shouldAutoInstall({ ...base, cliPath: '/Users/x/GitHub/termbus/dist/cli.js' })).toBeNull()
  })
  const plist = '<string>/Users/x/.nvm/versions/node/v22/bin/node</string><string>/usr/local/lib/node_modules/termbus/dist/cli.js</string><string>snapshot</string><string>/Users/x/.termbus/snapshot.log</string>'
  const on = { status: 'on' as const, since: 1 }
  it('repairs a service whose node or cli path is gone', () => {
    expect(shouldAutoInstall({ ...base, state: on, plist, exists: (p) => !p.includes('/v22/') })).toBe('repair')
  })
  it('leaves a healthy service alone (log files need not exist)', () => {
    expect(shouldAutoInstall({ ...base, state: on, plist, exists: (p) => !p.endsWith('.log') })).toBeNull()
  })
  it('never repairs when the user turned it off', () => {
    expect(shouldAutoInstall({ ...base, state: { status: 'off', since: 1 }, plist, exists: () => false })).toBeNull()
  })
})

describe('autosave state file', () => {
  it('round-trips and tolerates a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'termbus-autosave-'))
    expect(readAutosaveState(home)).toBeNull()
    writeAutosaveState('off', home)
    expect(readAutosaveState(home)?.status).toBe('off')
  })
})
