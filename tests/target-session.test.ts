import { describe, expect, it } from 'vitest'
import { checkTargetSession } from '../src/commands/bridge.js'

describe('checkTargetSession (the pane must run the chat the message is for)', () => {
  it('same conversation → ok', async () => {
    expect(await checkTargetSession('/dev/ttys001', 'abc', async () => 'abc')).toBeNull()
  })
  it('different conversation → refused, nothing typed', async () => {
    expect(await checkTargetSession('/dev/ttys001', 'abc', async () => 'xyz')).toMatch(/different conversation/)
  })
  it('unreadable → refused (fail closed)', async () => {
    expect(await checkTargetSession('/dev/ttys001', 'abc', async () => null)).toMatch(/can't confirm/)
  })
})
