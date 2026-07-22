import { describe, expect, it } from 'vitest'
import { agentScreenState } from '../src/core/idle.js'
import { diffStates } from '../src/core/watch.js'

const CLAUDE_IDLE = '╭─╮\n│ ❯ Try "edit a file" │\n╰─╯\n  ? for shortcuts · ← for agents'
const CLAUDE_BUSY = '✻ Churning… (esc to interrupt)'

const CLAUDE_PERMISSION = [
  'Bash command',
  '',
  '  rm -f build/cache.json',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. Yes, and don’t ask again for rm commands',
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n')

const CLAUDE_TRUST = [
  'Do you trust the files in this folder?',
  '',
  '❯ 1. Yes, I trust this folder',
  '  2. No, exit',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n')

// verbatim from a real Codex edit-approval dialog
const CODEX_PERMISSION = [
  'Would you like to make the following edits?',
  '',
  '❯ 1. Yes, proceed (y)',
  '  2. Yes, and don’t ask again for these files (a)',
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  'Press enter to confirm or esc to cancel',
].join('\n')

describe('agentScreenState', () => {
  it('classifies idle and busy as before', () => {
    expect(agentScreenState('claude', CLAUDE_IDLE)).toBe('idle')
    expect(agentScreenState('claude', CLAUDE_BUSY)).toBe('busy')
  })

  it('detects claude permission and trust dialogs', () => {
    expect(agentScreenState('claude', CLAUDE_PERMISSION)).toBe('awaiting-input')
    expect(agentScreenState('claude', CLAUDE_TRUST)).toBe('awaiting-input')
  })

  it('detects codex approval dialogs', () => {
    expect(agentScreenState('codex', CODEX_PERMISSION)).toBe('awaiting-input')
  })

  it('busy wins when working chrome and dialog-like text coexist', () => {
    expect(agentScreenState('claude', `${CLAUDE_PERMISSION}\n✻ Churning… (esc to interrupt)`)).toBe('busy')
  })

  it('dialog text scrolled far into the transcript does not trigger', () => {
    const scrolled = CLAUDE_PERMISSION + '\n'.repeat(30) + CLAUDE_IDLE
    expect(agentScreenState('claude', scrolled)).toBe('idle')
  })
})

describe('diffStates', () => {
  const snap = (id: string, state: string) => ({ id, label: `w1.t1.${id}`, title: id, state })

  it('reports transitions once, not every poll', () => {
    let prev = new Map([['a', snap('a', 'busy')]])
    const tick1 = diffStates(prev, [snap('a', 'awaiting-input')])
    expect(tick1).toEqual([expect.objectContaining({ id: 'a', from: 'busy', to: 'awaiting-input' })])
    prev = new Map([['a', snap('a', 'awaiting-input')]])
    expect(diffStates(prev, [snap('a', 'awaiting-input')])).toEqual([])
  })

  it('reports new and disappeared panes', () => {
    const prev = new Map([['a', snap('a', 'idle')]])
    const events = diffStates(prev, [snap('b', 'busy')])
    expect(events).toEqual([
      expect.objectContaining({ id: 'b', from: null, to: 'busy' }),
      expect.objectContaining({ id: 'a', from: 'idle', to: null }),
    ])
  })
})
