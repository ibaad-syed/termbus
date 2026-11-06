import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAgentRegistry } from '../src/core/agents.js'
import { agentProcessesFromPs } from '../src/restore/capture.js'
import { planRestore, tabLayout } from '../src/restore/plan.js'
import { buildResumeArgv } from '../src/restore/resume-command.js'
import type { SavedAgent, SavedPane } from '../src/restore/types.js'

const ID = 'adaptive-hardcover'

describe('buildResumeArgv for devin', () => {
  it('plain devin resumes by id', () => {
    expect(buildResumeArgv('devin', 'devin', ID)).toEqual({ argv: ['devin', '-r', ID], dropped: [] })
  })
  it('carries --model, --permission-mode and --sandbox', () => {
    expect(buildResumeArgv('devin', '/Users/u/.local/bin/devin --model opus --permission-mode=accept-edits --sandbox', ID)).toEqual({
      argv: ['/Users/u/.local/bin/devin', '-r', ID, '--model', 'opus', '--permission-mode=accept-edits', '--sandbox'],
      dropped: [],
    })
  })
  it('replaces -c/--continue/-r <id>/--resume=<id>', () => {
    expect(buildResumeArgv('devin', 'devin -c --model opus', ID).argv).toEqual(['devin', '-r', ID, '--model', 'opus'])
    expect(buildResumeArgv('devin', 'devin -r different-repair --model opus', ID).argv).toEqual(['devin', '-r', ID, '--model', 'opus'])
    expect(buildResumeArgv('devin', 'devin --resume=different-repair', ID).argv).toEqual(['devin', '-r', ID])
  })
  it('does not carry --config (not on the allowlist): no flags at all', () => {
    expect(buildResumeArgv('devin', 'devin --config /x.json --model opus', ID)).toEqual({
      argv: ['devin', '-r', ID],
      dropped: ['--model', 'opus', '--config', '/x.json'],
    })
  })
  it('a prompt makes the line ambiguous: nothing is carried', () => {
    expect(buildResumeArgv('devin', 'devin --model opus -- fix the --sandbox tests', ID)).toEqual({
      argv: ['devin', '-r', ID],
      dropped: ['--model', 'opus', '--', 'fix', 'the', '--sandbox', 'tests'],
    })
    expect(buildResumeArgv('devin', 'devin -p explain --sandbox', ID).argv).toEqual(['devin', '-r', ID])
    expect(buildResumeArgv('devin', 'devin -r foo --sandbox', ID).argv).toEqual(['devin', '-r', ID])
  })
})

describe('restore and the registry', () => {
  it('finds devin TUIs but not their acp helpers', () => {
    const ps = ` 11405 ttys006  devin --model opus
 42698 ttys006  /Users/u/.local/bin/devin acp
  7152 ttys003  claude --resume abc`
    expect(agentProcessesFromPs(ps)).toEqual([
      { pid: 11405, kind: 'devin', tty: 'ttys006' },
      { pid: 7152, kind: 'claude', tty: 'ttys003' },
    ])
  })

  const saved = (kind: string, sessionId: string | null, paneIndex = 1): SavedAgent => ({
    paneId: `P${paneIndex}`,
    windowIndex: 1,
    tabIndex: 1,
    paneIndex,
    title: kind,
    kind,
    sessionId,
    cwd: '/w',
    command: kind,
  })

  afterEach(() => {
    process.env.TERMBUS_AGENTS_FILE = '/nonexistent/termbus-tests/agents.json'
    resetAgentRegistry()
  })

  it('agents.json types are skipped with "no resume support"; devin restores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'termbus-agents-'))
    writeFileSync(join(dir, 'agents.json'), JSON.stringify([{ id: 'aider', commands: ['aider'], idle: ['^> ?$'] }]))
    process.env.TERMBUS_AGENTS_FILE = join(dir, 'agents.json')
    resetAgentRegistry()
    const plan = planRestore({ agents: [saved('aider', null, 1), saved('devin', ID, 2)] }, new Set())
    expect(plan.skipped.map((s) => [s.agent.kind, s.reason])).toEqual([['aider', 'no resume support']])
    expect(plan.windows.flat(2).map((a) => a.kind)).toEqual(['devin'])

    // in the rebuilt layout, the aider pane comes back as a shell in its directory
    const pane = (paneIndex: number, kind: string, sessionId: string | null): SavedPane => ({
      windowIndex: 1,
      tabIndex: 1,
      paneIndex,
      cols: 80,
      rows: 24,
      windowPx: { w: 1600, h: 800 },
      profile: null,
      name: kind,
      kind,
      sessionId,
      cwd: '/w',
    })
    const { leaves } = tabLayout([pane(1, 'aider', null), pane(2, 'devin', ID)], plan.windows[0][0])
    expect([...leaves.values()].map((l) => (l.agent ? l.agent.kind : 'shell'))).toEqual(['shell', 'devin'])
  })
})
