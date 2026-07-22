import { describe, expect, it } from 'vitest'
import { AppleScriptBackend, selfSessionIdFromEnv } from '../src/backends/applescript.js'

const live = process.env.TERMBUS_LIVE === '1' ? describe : describe.skip

live('AppleScriptBackend (live iTerm2)', () => {
  it('lists real panes and reads a screen', async () => {
    const b = new AppleScriptBackend(selfSessionIdFromEnv(process.env))
    const panes = await b.listPanes()
    expect(panes.length).toBeGreaterThan(0)
    for (const p of panes) {
      expect(p.id).toBeTruthy()
      expect(p.tty).toMatch(/^\/dev\/ttys/)
      expect(p.label).toMatch(/^w\d+\.t\d+\.p\d+$/)
    }
    const screen = await b.readScreen(panes[0].id)
    expect(typeof screen).toBe('string')
  }, 30_000)
})
