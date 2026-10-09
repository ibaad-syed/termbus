import { describe, expect, it } from 'vitest'
import { agentScreenState, looksLikeQuestionDialog, remoteSendRefusal } from '../src/core/idle.js'
import { paneState } from '../src/core/delivery.js'
import {
  DEVIN_BUSY_SYNTH,
  DEVIN_IDLE_AFTER_TURN,
  DEVIN_IDLE_REAL,
  DEVIN_PERMISSION_SYNTH,
  DEVIN_UNKNOWN,
} from './fixtures/devin-screens.js'

describe('Devin screen state', () => {
  it('VERIFIED: the real idle screen (composer between rules, footer last) is idle', () => {
    expect(agentScreenState('devin', DEVIN_IDLE_REAL)).toBe('idle')
    expect(paneState({ kind: 'devin', command: 'devin' }, DEVIN_IDLE_REAL)).toBe('idle')
  })
  it('idle with a wrapped, unsent draft in the composer', () => {
    expect(agentScreenState('devin', DEVIN_IDLE_AFTER_TURN)).toBe('idle')
  })
  it('UNVERIFIED: busy chrome from the binary\'s strings reads busy', () => {
    expect(agentScreenState('devin', DEVIN_BUSY_SYNTH)).toBe('busy')
  })
  it('UNVERIFIED: an approval list reads awaiting-input', () => {
    expect(agentScreenState('devin', DEVIN_PERMISSION_SYNTH)).toBe('awaiting-input')
  })
  it('conservative: a screen matching no marker is busy, never idle', () => {
    expect(agentScreenState('devin', DEVIN_UNKNOWN)).toBe('busy')
    expect(agentScreenState('devin', '')).toBe('busy')
  })
  it('the composer must be the last thing on screen', () => {
    const scrolledAway = `${DEVIN_IDLE_REAL}\nsomething printed below the composer\nand more`
    expect(agentScreenState('devin', scrolledAway)).toBe('busy')
  })
  it('has no question dialogs', () => {
    expect(looksLikeQuestionDialog('devin', DEVIN_PERMISSION_SYNTH)).toBe(false)
  })
  it('the placeholder "❭ 1." in a typed draft is not an option list', () => {
    const draft = DEVIN_IDLE_REAL.replace('❭ Ask Devin to build features, fix bugs, or work on your code', '❭ 1. fix the bug')
    expect(agentScreenState('devin', draft)).toBe('idle')
  })
  it('"Guide Devin while it works" alone reads busy (local sends need --wait)', () => {
    expect(agentScreenState('devin', DEVIN_IDLE_REAL.replace('Ask Devin to build features, fix bugs, or work on your code', 'Guide Devin while it works'))).toBe('busy')
  })
})

describe('HQ sends to Devin (remote gate, until calibrated)', () => {
  const REFUSAL = "Devin looks busy — try again when it's idle"
  it('only an idle, EMPTY composer (placeholder "Ask Devin to …" visible) is typed into', () => {
    expect(remoteSendRefusal('devin', DEVIN_IDLE_REAL)).toBeNull()
  })
  it('anything else is refused', () => {
    expect(remoteSendRefusal('devin', DEVIN_BUSY_SYNTH)).toBe(REFUSAL)
    expect(remoteSendRefusal('devin', DEVIN_IDLE_AFTER_TURN)).toBe(REFUSAL) // a draft in the composer
    expect(remoteSendRefusal('devin', DEVIN_PERMISSION_SYNTH)).toBe(REFUSAL)
    expect(remoteSendRefusal('devin', DEVIN_UNKNOWN)).toBe(REFUSAL)
    expect(remoteSendRefusal('devin', DEVIN_IDLE_REAL.replace('Ask Devin to build features, fix bugs, or work on your code', 'Guide Devin while it works'))).toBe(REFUSAL)
  })
  it('claude and codex have no extra gate', () => {
    expect(remoteSendRefusal('claude', 'anything')).toBeNull()
    expect(remoteSendRefusal('codex', 'anything')).toBeNull()
  })
})
