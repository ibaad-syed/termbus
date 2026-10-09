import { describe, expect, it } from 'vitest'
import { agentScreenState, looksLikeQuestionDialog } from '../src/core/idle.js'
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
})
