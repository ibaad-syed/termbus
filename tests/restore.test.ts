import { describe, expect, it } from 'vitest'
import { claudeSessionFromFile, codexMainThread } from '../src/restore/identity.js'
import { buildResumeArgv, launchScript, restoreShellLine, shellQuote } from '../src/restore/resume-command.js'
import { emptyStore, pickGeneration, recordGeneration, STABLE_MS } from '../src/restore/store.js'
import { planRestore } from '../src/restore/plan.js'
import { agentProcessesFromPs, itermInstanceFromPs } from '../src/restore/capture.js'
import type { SavedAgent } from '../src/restore/types.js'

// Real shape of ~/.claude/sessions/<pid>.json (Claude Code 2.1.x)
const CLAUDE_SESSION_FILE = JSON.stringify({
  pid: 53234,
  sessionId: '8a10d93d-590e-45d4-adff-bfc443882430',
  cwd: '/Users/x/Documents/GitHub/termbus',
  startedAt: 1791492462152,
  procStart: 'Thu Oct  8 20:47:41 2026',
  kind: 'interactive',
  name: 'termbus-d6',
  status: 'busy',
})

describe('claudeSessionFromFile', () => {
  it('reads sessionId + cwd + name', () => {
    expect(claudeSessionFromFile(CLAUDE_SESSION_FILE, 'Thu Oct  8 20:47:41 2026')).toEqual({
      sessionId: '8a10d93d-590e-45d4-adff-bfc443882430',
      cwd: '/Users/x/Documents/GitHub/termbus',
      name: 'termbus-d6',
    })
  })

  it('tolerates whitespace differences in procStart (ps pads the day)', () => {
    expect(claudeSessionFromFile(CLAUDE_SESSION_FILE, 'Thu Oct 8 20:47:41 2026')?.sessionId).toBe(
      '8a10d93d-590e-45d4-adff-bfc443882430',
    )
  })

  it('rejects a stale file left by an earlier process that had the same pid', () => {
    expect(claudeSessionFromFile(CLAUDE_SESSION_FILE, 'Fri Oct  9 09:00:00 2026')).toBeNull()
  })

  it('matches any of several renderings (Claude records UTC, ps defaults to local time)', () => {
    expect(
      claudeSessionFromFile(CLAUDE_SESSION_FILE, ['Thu Oct  8 16:47:41 2026', 'Thu Oct  8 20:47:41 2026'])?.sessionId,
    ).toBe('8a10d93d-590e-45d4-adff-bfc443882430')
    expect(claudeSessionFromFile(CLAUDE_SESSION_FILE, ['Thu Oct  8 16:47:41 2026'])).toBeNull()
  })

  it('accepts when the process start time is unknown', () => {
    expect(claudeSessionFromFile(CLAUDE_SESSION_FILE, null)?.sessionId).toBe('8a10d93d-590e-45d4-adff-bfc443882430')
  })

  it('returns null for garbage or missing sessionId', () => {
    expect(claudeSessionFromFile('not json', null)).toBeNull()
    expect(claudeSessionFromFile('{"pid":1}', null)).toBeNull()
  })
})

describe('codexMainThread', () => {
  // A resumed Codex TUI holds its own (forked) rollout open plus one per subagent.
  const main = {
    mtimeMs: 100,
    meta: { id: '01a1189c-1b3e-7e83-bffd-482cad01d407', forked_from_id: '01a111c5-aaaa', cwd: '/w/Ponder' },
  }
  const sub1 = {
    mtimeMs: 300,
    meta: { id: '01a11bb0-8220-7da3-be6d-a89168d08570', parent_thread_id: '01a1189c-1b3e-7e83-bffd-482cad01d407', cwd: '/w/Ponder' },
  }

  it('ignores subagent threads even when they were written more recently', () => {
    expect(codexMainThread([sub1, main])).toEqual({ sessionId: '01a1189c-1b3e-7e83-bffd-482cad01d407', cwd: '/w/Ponder' })
  })

  it('picks the most recently written of several top-level threads', () => {
    const older = { mtimeMs: 50, meta: { id: 'old-thread', cwd: '/w/a' } }
    expect(codexMainThread([older, main])?.sessionId).toBe(main.meta.id)
  })

  it('returns null when nothing qualifies', () => {
    expect(codexMainThread([sub1])).toBeNull()
    expect(codexMainThread([])).toBeNull()
  })
})

describe('buildResumeArgv', () => {
  const S = 'abac5693-8408-4ffb-a434-ea91fb2b337c'

  it('claude: keeps the permission posture, swaps the old resume for the new id', () => {
    const r = buildResumeArgv('claude', 'claude --resume 65392c89-c895-439b-be3c-c5e8be7296a0 --dangerously-skip-permissions', S)
    expect(r.argv).toEqual(['claude', '--resume', S, '--dangerously-skip-permissions'])
    expect(r.dropped).toEqual([])
  })

  it('claude: keeps value flags with their values, both spellings', () => {
    const r = buildResumeArgv('claude', 'claude --model opus --permission-mode=plan --add-dir /tmp/x', S)
    expect(r.argv).toEqual(['claude', '--resume', S, '--model', 'opus', '--permission-mode=plan', '--add-dir', '/tmp/x'])
  })

  it('claude: never replays a positional prompt', () => {
    const r = buildResumeArgv('claude', 'claude fix the login bug', S)
    expect(r.argv).toEqual(['claude', '--resume', S])
    expect(r.dropped).toEqual(['fix', 'the', 'login', 'bug'])
  })

  it('claude: strips -c/--continue/--fork-session/--session-id silently', () => {
    const r = buildResumeArgv('claude', `claude -c --fork-session --session-id ${S} --dangerously-skip-permissions`, S)
    expect(r.argv).toEqual(['claude', '--resume', S, '--dangerously-skip-permissions'])
    expect(r.dropped).toEqual([])
  })

  it('any unrecognized token → carry NO flags (ps lost the quoting; a prompt may contain flag-like text)', () => {
    // real argv was: codex "explain --yolo"
    const r = buildResumeArgv('codex', 'codex explain --yolo', S)
    expect(r.argv).toEqual(['codex', 'resume', S])
    expect(r.dropped).toEqual(['--yolo', 'explain'])
    // real argv was: claude "what does --dangerously-skip-permissions do"
    const c = buildResumeArgv('claude', 'claude what does --dangerously-skip-permissions do', S)
    expect(c.argv).toEqual(['claude', '--resume', S])
    // an unknown flag is ambiguous too (does it take a value?)
    expect(buildResumeArgv('claude', 'claude --some-new-flag x --verbose', S).argv).toEqual(['claude', '--resume', S])
  })

  it('a prompt that LOOKS like a resume subcommand stays ambiguous (codex "resume x --yolo")', () => {
    expect(buildResumeArgv('codex', 'codex resume x --yolo', S).argv).toEqual(['codex', 'resume', S])
    expect(buildResumeArgv('claude', 'claude --resume foo --dangerously-skip-permissions', S).argv).toEqual(['claude', '--resume', S])
  })

  it('codex: resume <id> plus kept flags, the old id replaced', () => {
    const r = buildResumeArgv('codex', 'codex resume 01a111c5-3536-7b50-8e80-95ea547bc187 --yolo -m gpt-5', S)
    expect(r.argv).toEqual(['codex', 'resume', S, '--yolo', '-m', 'gpt-5'])
    expect(r.dropped).toEqual([])
  })

  it('codex: flags before the subcommand and --last are handled', () => {
    const r = buildResumeArgv('codex', 'codex --sandbox workspace-write resume --last', S)
    expect(r.argv).toEqual(['codex', 'resume', S, '--sandbox', 'workspace-write'])
  })

  it('keeps an absolute binary path', () => {
    expect(buildResumeArgv('codex', '/opt/homebrew/bin/codex', S).argv[0]).toBe('/opt/homebrew/bin/codex')
  })
})

describe('shell line', () => {
  it('quotes safely', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote('plain-1.2/x')).toBe('plain-1.2/x')
  })
  it('cds into the cwd first', () => {
    expect(restoreShellLine('/Users/a b/proj', ['claude', '--resume', 'x'])).toBe(`cd '/Users/a b/proj' && claude --resume x`)
  })
})

const agent = (over: Partial<SavedAgent>): SavedAgent => ({
  paneId: 'p',
  windowIndex: 1,
  tabIndex: 1,
  paneIndex: 1,
  title: 't',
  kind: 'claude',
  sessionId: 's',
  cwd: '/w',
  command: 'claude',
  ...over,
})

describe('snapshot store', () => {
  it('appends a generation when the agent set changes, refreshes lastSeenAt when it does not', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'x' })], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'x' })], now: 2 })
    expect(s.generations).toHaveLength(1)
    expect(s.generations[0].lastSeenAt).toBe(2)
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'y' })], now: 3 })
    expect(s.generations).toHaveLength(2)
    expect(s.generations[1].id).toBe(2)
  })

  it('a title change alone (spinner glyphs) is not a new generation, but the title is refreshed', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ title: '◐ working' })], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ title: '◑ working' })], now: 2 })
    expect(s.generations).toHaveLength(1)
    expect(s.generations[0].agents[0].title).toBe('◑ working')
  })

  it('a new terminal instance always starts a new generation', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [], now: 1 })
    s = recordGeneration(s, { instance: 'B', agents: [], now: 2 })
    expect(s.generations).toHaveLength(2)
  })

  it('caps history', () => {
    let s = emptyStore()
    for (let i = 0; i < 10; i++) s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: `s${i}` })], now: i }, 4)
    expect(s.generations).toHaveLength(4)
    expect(s.generations[0].agents[0].sessionId).toBe('s6')
  })

  it('restore source = the final state of the previous terminal instance', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' })], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' }), agent({ sessionId: 'a2', paneIndex: 2 })], now: 2 })
    // reboot: iTerm comes back empty; the autosaver records that — it must not clobber A
    s = recordGeneration(s, { instance: 'B', agents: [], now: 3 })
    const g = pickGeneration(s, 'B')
    expect(g?.agents.map((a) => a.sessionId)).toEqual(['a1', 'a2'])
  })

  it('shutdown: half-closed states are short-lived; the last STABLE state wins', () => {
    let s = emptyStore()
    const both = [agent({ sessionId: 'a1' }), agent({ sessionId: 'a2', paneIndex: 2 })]
    s = recordGeneration(s, { instance: 'A', agents: both, now: 0 })
    s = recordGeneration(s, { instance: 'A', agents: both, now: STABLE_MS + 1 }) // sat there a while
    // iTerm quitting slowly, observed across two passes
    s = recordGeneration(s, { instance: 'A', agents: [both[0]], now: STABLE_MS + 15_000 })
    s = recordGeneration(s, { instance: 'A', agents: [], now: STABLE_MS + 30_000 })
    s = recordGeneration(s, { instance: 'B', agents: [], now: STABLE_MS + 90_000 })
    expect(pickGeneration(s, 'B')?.agents.map((a) => a.sessionId)).toEqual(['a1', 'a2'])
  })

  it('everything closed on purpose (empty state persisted) → nothing to restore', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' })], now: 0 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' })], now: STABLE_MS })
    s = recordGeneration(s, { instance: 'A', agents: [], now: STABLE_MS + 1000 })
    s = recordGeneration(s, { instance: 'A', agents: [], now: 3 * STABLE_MS })
    s = recordGeneration(s, { instance: 'B', agents: [], now: 4 * STABLE_MS })
    expect(pickGeneration(s, 'B')).toBeNull()
  })

  it('no stable state at all → the last state of that instance', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' })], now: 0 })
    s = recordGeneration(s, { instance: 'B', agents: [], now: 1000 })
    expect(pickGeneration(s, 'B')?.agents[0].sessionId).toBe('a1')
  })

  it('never reaches into an older instance', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'old' })], now: 0 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'old' })], now: STABLE_MS })
    s = recordGeneration(s, { instance: 'B', agents: [], now: 2 * STABLE_MS })
    s = recordGeneration(s, { instance: 'C', agents: [], now: 3 * STABLE_MS })
    expect(pickGeneration(s, 'C')).toBeNull()
  })

  it('terminal not running → the latest generation', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'a1' })], now: 1 })
    expect(pickGeneration(s, null)?.agents[0].sessionId).toBe('a1')
  })

  it('no earlier instance → null', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({})], now: 1 })
    expect(pickGeneration(s, 'A')).toBeNull()
  })
})

describe('planRestore', () => {
  it('groups by window → tab → pane order', () => {
    const gen = {
      agents: [
        agent({ sessionId: 'c', windowIndex: 2, tabIndex: 1, paneIndex: 1 }),
        agent({ sessionId: 'b', windowIndex: 1, tabIndex: 2, paneIndex: 1 }),
        agent({ sessionId: 'a2', windowIndex: 1, tabIndex: 1, paneIndex: 2 }),
        agent({ sessionId: 'a1', windowIndex: 1, tabIndex: 1, paneIndex: 1 }),
      ],
    }
    const plan = planRestore(gen, new Set())
    expect(plan.windows.map((w) => w.map((t) => t.map((p) => p.sessionId)))).toEqual([[['a1', 'a2'], ['b']], [['c']]])
    expect(plan.skipped).toEqual([])
  })

  it('skips sessions already running somewhere (restore is idempotent)', () => {
    const plan = planRestore({ agents: [agent({ sessionId: 'live' }), agent({ sessionId: 'dead', paneIndex: 2 })] }, new Set(['live']))
    expect(plan.windows.flat(2).map((p) => p.sessionId)).toEqual(['dead'])
    expect(plan.skipped).toEqual([{ agent: expect.objectContaining({ sessionId: 'live' }), reason: 'already running' }])
  })

  it('skips agents with no known session or cwd instead of starting a blank one', () => {
    const plan = planRestore({ agents: [agent({ sessionId: null }), agent({ sessionId: 'x', cwd: null })] }, new Set())
    expect(plan.windows).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(['session id unknown', 'working directory unknown'])
  })

  it('a running agent that could not be identified blocks saved agents it might be', () => {
    const gen = { agents: [agent({ sessionId: 'x', cwd: '/w/a' }), agent({ sessionId: 'y', cwd: '/w/b', paneIndex: 2 }), agent({ sessionId: 'z', kind: 'codex', cwd: '/w/a', paneIndex: 3 })] }
    const plan = planRestore(gen, new Set(), [{ kind: 'claude', cwd: '/w/a' }])
    expect(plan.windows.flat(2).map((p) => p.sessionId)).toEqual(['y', 'z'])
    // unknown directory: every saved agent of that kind is suspect
    expect(planRestore(gen, new Set(), [{ kind: 'claude', cwd: null }]).windows.flat(2).map((p) => p.sessionId)).toEqual(['z'])
  })

  it('the same session saved twice is restored once', () => {
    const plan = planRestore({ agents: [agent({ sessionId: 'x' }), agent({ sessionId: 'x', paneIndex: 2 })] }, new Set())
    expect(plan.windows.flat(2)).toHaveLength(1)
  })
})

describe('itermInstanceFromPs', () => {
  it('finds the iTerm2 app, not its helpers', () => {
    const ps = `  998 Wed Oct  7 01:10:02 2026     /Users/x/Library/Application Support/iTerm2/iTermServer-3.6.6
  483 Wed Oct  7 01:10:00 2026     /Applications/iTerm.app/Contents/MacOS/iTerm2
 1166 Wed Oct  7 01:10:03 2026     /Applications/iTerm.app/Contents/XPCServices/pidinfo.xpc/Contents/MacOS/pidinfo`
    expect(itermInstanceFromPs(ps)).toBe('483@Wed Oct 7 01:10:00 2026')
  })
  it('null when iTerm2 is not running', () => {
    expect(itermInstanceFromPs('  1 Wed Oct  7 01:00:00 2026     /sbin/launchd')).toBeNull()
  })
})

describe('agentProcessesFromPs', () => {
  it('finds interactive claude/codex on a tty, ignores daemons and helpers', () => {
    const ps = `  7152 ttys003  claude --resume abc --dangerously-skip-permissions
 80463 ttys002  codex resume 01a1 --yolo
  6186 ??       /Users/x/.codex/packages/bin/codex app-server daemon pid-update-loop
 17143 ??       codex exec -s read-only
 34589 ttys003  npm exec mcp-remote https://mcp.linear.app/mcp
 99999 ttys004  /opt/homebrew/bin/codex`
    expect(agentProcessesFromPs(ps)).toEqual([
      { pid: 7152, kind: 'claude' },
      { pid: 80463, kind: 'codex' },
      { pid: 99999, kind: 'codex' },
    ])
  })
})

describe('launchScript', () => {
  it('zsh: interactive login shell runs the line, then leaves a shell behind', () => {
    expect(launchScript('/bin/zsh', "cd /w && claude --resume x")).toBe(
      '#!/bin/zsh -il\nrm -f "$0"\ncd /w && claude --resume x\nexec /bin/zsh -il\n',
    )
  })
  it('fish: launch through zsh (quoting differs), then hand over to fish', () => {
    const s = launchScript('/opt/homebrew/bin/fish', 'cd /w && codex resume x')
    expect(s.startsWith('#!/bin/zsh -il\n')).toBe(true)
    expect(s.endsWith('exec /opt/homebrew/bin/fish -il\n')).toBe(true)
  })
})
