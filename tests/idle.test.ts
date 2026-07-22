import { describe, expect, it } from 'vitest'
import { looksBusy } from '../src/core/idle.js'

const CLAUDE_BUSY = `● Searching the codebase…

  ✻ Thinking…

  ctrl+c to stop · esc to interrupt`

const CLAUDE_IDLE = `● Done. The fix is in src/foo.ts.

╭──────────────────────────────────────╮
│ >                                    │
╰──────────────────────────────────────╯
  ? for shortcuts`

const CODEX_BUSY = `▌ Working (12s · esc to interrupt)`

const CODEX_IDLE = `› fixed the bug in parser.rs

  ⏎ send   ctrl+c quit`

// Real chrome captured live from iTerm2 Claude Code sessions (UI lines only).
// The busy footer carries a "· ← for agents" suffix and the spinner glyph
// cycles (✻ ✽ ✶ ✢); the idle session shows "? for shortcuts".
const CLAUDE_BUSY_REAL = `✻ Calculating… (37s · ↓ 1.1k tokens · still thinking)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents · ↓ to manage`

const CLAUDE_IDLE_REAL = `✻ Crunched for 29s
  ? for shortcuts · ← for agents`

describe('looksBusy', () => {
  it('detects busy claude', () => {
    expect(looksBusy('claude', CLAUDE_BUSY)).toBe(true)
  })
  it('detects idle claude', () => {
    expect(looksBusy('claude', CLAUDE_IDLE)).toBe(false)
  })
  it('detects busy codex', () => {
    expect(looksBusy('codex', CODEX_BUSY)).toBe(true)
  })
  it('detects idle codex', () => {
    expect(looksBusy('codex', CODEX_IDLE)).toBe(false)
  })
  it('detects busy claude from real captured chrome', () => {
    expect(looksBusy('claude', CLAUDE_BUSY_REAL)).toBe(true)
  })
  it('detects idle claude from real captured chrome', () => {
    expect(looksBusy('claude', CLAUDE_IDLE_REAL)).toBe(false)
  })
})
