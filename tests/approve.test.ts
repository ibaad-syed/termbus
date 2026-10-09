import { describe, expect, it } from 'vitest'
import { cursorOnAffirmative, readOptions, stepsToAffirmative } from '../src/core/approve.js'

// Real Claude Code 2.1.288 folder-trust dialog (captured 2026-10-08)
const TRUST = ` Accessing workspace:
 
 /private/tmp/scratchpad/e2e-proj 
 
 Quick safety check: Is this a project 
 you created or one you trust? 
 
 Security guide 
 
 ❯ No, exit 
   Yes, I trust this folder 
 
 Enter to confirm · Esc to cancel`

const TRUST_MOVED = TRUST.replace(' ❯ No, exit \n   Yes, I trust this folder', '   No, exit \n ❯ Yes, I trust this folder')

// Typical permission prompt: Yes is highlighted already
const PERMISSION = `⏺ Bash command

  grep -rln "hnsw" apps/server/migrations/

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for grep commands in /Users/x/proj
  3. No, and tell Claude what to do differently (esc)

Esc to cancel · Tab to amend`

// Codex trust prompt: affirmative first
const CODEX_TRUST = `  Trust this folder? Codex can read, edit, and run files here.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit`

describe('approve: pick the affirmative option', () => {
  it('permission prompt: already on Yes → Enter', () => {
    expect(readOptions(PERMISSION)?.lines).toEqual([
      '1. Yes',
      "2. Yes, and don't ask again for grep commands in /Users/x/proj",
      '3. No, and tell Claude what to do differently (esc)',
    ])
    expect(stepsToAffirmative(PERMISSION)).toBe(0)
  })
  it('Claude folder trust: cursor on "No, exit" → one Down, then verify', () => {
    expect(readOptions(TRUST)).toEqual({ lines: ['No, exit', 'Yes, I trust this folder'], cursor: 0 })
    expect(stepsToAffirmative(TRUST)).toBe(1)
    expect(cursorOnAffirmative(TRUST)).toBe(false)
    expect(cursorOnAffirmative(TRUST_MOVED)).toBe(true)
  })
  it('Codex trust: already on "Trust and continue"', () => {
    expect(stepsToAffirmative(CODEX_TRUST)).toBe(0)
  })
  it('no affirmative option → null (refuse to guess)', () => {
    expect(stepsToAffirmative(' ❯ Delete everything\n   Delete some things\n')).toBeNull()
    expect(stepsToAffirmative('no dialog here')).toBeNull()
  })
})
