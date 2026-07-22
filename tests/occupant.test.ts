import { describe, expect, it } from 'vitest'
import { classifyPs } from '../src/core/occupant.js'

// Real fixtures captured in the 2026-07-22 spike
const CLAUDE_PANE = `33338 33337 Ss   login -fp ibrahimibaadsyed
33340 33338 S    -zsh
34575 33340 S+   claude --resume 49543212-950a-4604-9923-3092d84bb2f4 --dangerously-skip-permissions
34589 34575 S+   npm exec mcp-remote https://mcp.linear.app/mcp
34608 34575 S+   caffeinate -i -t 300
34624 34589 S+   node /Users/x/.bin/mcp-remote https://mcp.linear.app/mcp`

const IDLE_SHELL_PANE = `33811 33337 Ss   login -fp ibrahimibaadsyed
33812 33811 S+   -zsh`

const CODEX_PANE = `1001 1000 Ss   login -fp user
1002 1001 S    -zsh
1010 1002 S+   codex --model o4`

const VIM_PANE = `2001 2000 Ss   login -fp user
2002 2001 S    -zsh
2010 2002 S+   vim notes.md`

// PID wraparound: the TUI (claude, pid 99998) has a HIGHER pid than its own
// node child (pid 150, ppid 99998). Lowest-pid selection would wrongly pick the
// child; ppid-based selection picks claude because it is parented by the shell.
const WRAPAROUND_PANE = `100 99   Ss   login -fp user
200 100  S    -zsh
99998 200 S+   claude --resume abc
150 99998 S+   node /Users/x/.bin/mcp-remote https://mcp.linear.app/mcp`

describe('classifyPs', () => {
  it('classifies a claude pane by lowest-pid foreground non-shell process', () => {
    const occ = classifyPs(CLAUDE_PANE)
    expect(occ.kind).toBe('claude')
    expect(occ.command).toContain('claude --resume')
  })
  it('classifies an idle shell', () => {
    expect(classifyPs(IDLE_SHELL_PANE)).toEqual({ kind: 'shell', command: null })
  })
  it('classifies codex', () => {
    expect(classifyPs(CODEX_PANE).kind).toBe('codex')
  })
  it('classifies other commands', () => {
    const occ = classifyPs(VIM_PANE)
    expect(occ.kind).toBe('command')
    expect(occ.command).toBe('vim notes.md')
  })
  it('returns unknown for empty ps output', () => {
    expect(classifyPs('').kind).toBe('unknown')
  })
  it('classifies the shell-parented TUI even when its pid wrapped above its child', () => {
    const occ = classifyPs(WRAPAROUND_PANE)
    expect(occ.kind).toBe('claude')
    expect(occ.command).toContain('claude --resume')
  })
})
