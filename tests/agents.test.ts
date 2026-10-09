import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentDef,
  agentForCommand,
  agentLabel,
  allAgents,
  isAgentKind,
  parseAgentsFile,
  resetAgentRegistry,
} from '../src/core/agents.js'
import { ensureDeliverable, nativeQueue, paneState } from '../src/core/delivery.js'
import { classifyAncestry } from '../src/core/envelope.js'
import { agentScreenState } from '../src/core/idle.js'
import { classifyPs } from '../src/core/occupant.js'
import type { Backend, Pane } from '../src/core/types.js'

const ORIGINAL = process.env.TERMBUS_AGENTS_FILE

function useAgentsFile(content: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), 'termbus-agents-'))
  const path = join(dir, 'agents.json')
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  process.env.TERMBUS_AGENTS_FILE = path
  resetAgentRegistry()
}

afterEach(() => {
  process.env.TERMBUS_AGENTS_FILE = ORIGINAL
  resetAgentRegistry()
  vi.restoreAllMocks()
})

describe('built-in registry', () => {
  it('claude, codex and devin are agents; shells and commands are not', () => {
    expect(allAgents().map((a) => a.id)).toEqual(['claude', 'codex', 'devin'])
    for (const k of ['claude', 'codex', 'devin']) expect(isAgentKind(k)).toBe(true)
    for (const k of ['shell', 'command', 'unknown', 'aider']) expect(isAgentKind(k)).toBe(false)
    expect(agentLabel('devin')).toBe('Devin')
    expect(agentLabel('shell')).toBeNull()
  })
  it('devin cannot be queued into (unverified), claude/codex can', () => {
    expect(nativeQueue('claude')).toBe(true)
    expect(nativeQueue('codex')).toBe(true)
    expect(nativeQueue('devin')).toBe(false)
  })
  it('recognises the Devin TUI but not its `devin acp` helper', () => {
    expect(agentForCommand('devin')?.id).toBe('devin')
    expect(agentForCommand('/Users/u/.local/bin/devin -r adaptive-hardcover')?.id).toBe('devin')
    expect(agentForCommand('/Users/u/.local/bin/devin acp')).toBeUndefined()
    expect(agentForCommand('/Users/u/.local/bin/devin acp', { respectExclude: false })?.id).toBe('devin')
  })
})

describe('classifyPs with devin (real pane process tree)', () => {
  const PS = `11400 11399 Ss   -zsh
11405 11400 S+   devin
42698 11405 S+   /Users/u/.local/bin/devin acp
42710 42698 S+   node /Users/u/.npm/_npx/mcp-server/index.js`
  it('the pane is a devin pane', () => {
    expect(classifyPs(PS)).toEqual({ kind: 'devin', command: 'devin' })
  })
})

describe('envelope sender kind', () => {
  it('a termbus run by a Devin tool call (under `devin acp`) is kind devin', () => {
    const rows = [
      { pid: 100, ppid: 1, comm: '-zsh' },
      { pid: 200, ppid: 100, comm: 'devin' },
      { pid: 300, ppid: 200, comm: '/Users/u/.local/bin/devin' },
      { pid: 400, ppid: 300, comm: '/bin/zsh' },
      { pid: 500, ppid: 400, comm: 'node' },
    ]
    expect(classifyAncestry(rows, 500)).toBe('devin')
  })
})

describe('agents.json (config-defined agent types)', () => {
  it('validates entries; bad ones are skipped with a one-line warning each', () => {
    const { agents, warnings } = parseAgentsFile(
      JSON.stringify([
        { id: 'aider', label: 'Aider', commands: ['aider'], busy: ['Waiting for'], prompt: ['\\(Y\\)es/\\(N\\)o'], idle: ['^> ?$'] },
        { id: 'claude', commands: ['x'] }, // built in
        { id: 'Bad Id', commands: ['x'] },
        { id: 'nocmd', commands: [] },
        { id: 'pathcmd', commands: ['/usr/bin/x'] },
        { id: 'badre', commands: ['x'], busy: ['(unclosed'] },
        { id: 'longre', commands: ['x'], busy: ['a'.repeat(201)] },
        { id: 'aider', commands: ['aider2'], idle: ['x'] }, // duplicate
        { id: 'shell', commands: ['x'] }, // reserved
        'nope',
      ]),
    )
    expect(agents.map((a) => a.id)).toEqual(['aider'])
    expect(warnings).toHaveLength(9)
    expect(warnings.join('\n')).toMatch(/defined twice/)
    for (const w of warnings) expect(w).not.toContain('\n')
    expect(agents[0]).toMatchObject({ label: 'Aider', transcript: 'screen', nativeQueue: false, builtin: false })
    expect(agents[0].resume).toBeUndefined()
    expect(agents[0].screen.question).toBeUndefined()
  })
  it('every entry needs at least one idle pattern (unknown screens must read busy)', () => {
    const { agents, warnings } = parseAgentsFile(JSON.stringify([{ id: 'aider', commands: ['aider'], busy: ['x'] }, { id: 'goose', commands: ['goose'], idle: [] }]))
    expect(agents).toEqual([])
    expect(warnings).toHaveLength(2)
    for (const w of warnings) expect(w).toMatch(/needs at least one "idle" pattern/)
  })
  it('refuses shells, interpreters, remote shells, wrappers, multiplexers and editors as agent commands', () => {
    const never = 'ssh mosh telnet et sftp ftp nc bash zsh sh fish dash ksh tcsh csh nu python python3 python2 pip node deno bun npx ruby irb perl php lua R julia psql mysql sqlite3 redis-cli mongo mongosh sudo su doas env nohup time xargs docker podman kubectl tmux screen vim nvim vi emacs nano less more man'.split(' ')
    for (const c of never) {
      const r = parseAgentsFile(JSON.stringify([{ id: 'sneaky', commands: ['aider', c], idle: ['x'] }]))
      expect(r.agents, c).toEqual([])
      expect(r.warnings[0]).toMatch(/not an agent TUI/)
    }
    expect(parseAgentsFile(JSON.stringify([{ id: 'py', commands: ['python3.12'], idle: ['x'] }])).agents).toEqual([])
  })
  it('refuses regexes that could backtrack catastrophically, and backreferences', () => {
    for (const re of ['(a+)+$', '(x*y)*', '(\\w+\\s?)+$', '(a?){20}', '(.)\\1', '(?<q>.)\\k<q>']) {
      const r = parseAgentsFile(JSON.stringify([{ id: 'redos', commands: ['x'], busy: [re], idle: ['ok'] }]))
      expect(r.agents, re).toEqual([])
      expect(r.warnings[0]).toMatch(/nested quantifier|backreference/)
    }
    // ordinary patterns, quantified groups without inner quantifiers, are fine
    const fine = parseAgentsFile(JSON.stringify([{ id: 'okre', commands: ['x'], busy: ['(ab)+', 'Working( on)? it', '\\(Y\\)es'], idle: ['^> ?$'] }]))
    expect(fine.warnings).toEqual([])
  })
  it('a file that is not a JSON array is ignored, never a crash', () => {
    expect(parseAgentsFile('{oops').agents).toEqual([])
    expect(parseAgentsFile('{"id":"x"}').warnings[0]).toMatch(/array/)
  })
  it('loads from TERMBUS_AGENTS_FILE and drives detection, state and delivery', async () => {
    useAgentsFile([{ id: 'aider', label: 'Aider', commands: ['aider'], busy: ['Waiting for'], prompt: ['\\(Y\\)es/\\(N\\)o'], idle: ['^> ?$'] }])
    expect(isAgentKind('aider')).toBe(true)
    expect(agentDef('aider')?.label).toBe('Aider')
    expect(classifyPs('100 1 Ss -zsh\n200 100 S+ aider --model x')).toEqual({ kind: 'aider', command: 'aider --model x' })
    expect(agentScreenState('aider', '> ')).toBe('idle')
    expect(agentScreenState('aider', 'Waiting for gpt-4…')).toBe('busy')
    expect(agentScreenState('aider', 'Apply edit? (Y)es/(N)o')).toBe('awaiting-input')
    expect(paneState({ kind: 'aider', command: 'aider' }, 'Waiting for x')).toBe('busy')

    // nativeQueue false: --queue on a busy pane is refused with a pointer to --wait
    const pane = { id: 'P', label: 'w1.t1.p1', title: 'aider' } as Pane
    const backend = { readScreen: async () => 'Waiting for model' } as unknown as Backend
    const deps = { backend, clock: { now: () => 0, sleep: async () => {} } }
    await expect(ensureDeliverable(deps, pane, { kind: 'aider', command: 'aider' }, 'queue', { timeoutMs: 0, pollMs: 1 })).rejects.toThrow(
      /no input queue — use --wait/,
    )
  })
  it('optional idle markers make unknown screens read busy', () => {
    useAgentsFile([{ id: 'goose', commands: ['goose'], idle: ['^\\( O\\)>$'] }])
    expect(agentScreenState('goose', 'blah\n( O)> ')).toBe('idle')
    expect(agentScreenState('goose', 'thinking hard')).toBe('busy')
  })
  it('warns on stderr once per file version, and a missing file is fine', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    useAgentsFile([{ id: 'X' }])
    expect(allAgents()).toHaveLength(3)
    allAgents()
    expect(err).toHaveBeenCalledTimes(1)
    process.env.TERMBUS_AGENTS_FILE = '/nonexistent/agents.json'
    resetAgentRegistry()
    expect(allAgents()).toHaveLength(3)
  })
})
