import { describe, expect, it } from 'vitest'
import { askAgent, askShell, type AskDeps } from '../src/core/ask.js'
import { AskTimeoutError, BusyPaneError } from '../src/core/errors.js'
import type { Backend, Pane } from '../src/core/types.js'

const PANE: Pane = {
  id: 'XYZ', label: 'w1.t1.p2', title: 'worker', tty: '/dev/ttys009',
  isSelf: false, windowIndex: 1, tabIndex: 1, paneIndex: 2,
}
const NONCE = 'deadbeef1234'

/** Backend that serves a scripted sequence of screens; sticks on the last one. */
function fakeBackend(screens: string[]): Backend & { sent: Array<{ text: string; submit: boolean }> } {
  let i = -1
  const sent: Array<{ text: string; submit: boolean }> = []
  return {
    name: 'fake',
    sent,
    async listPanes() { return [PANE] },
    async readScreen() { i = Math.min(i + 1, screens.length - 1); return screens[i] },
    async sendText(_id, text, submit) { sent.push({ text, submit }) },
  }
}

function deps(backend: Backend, files: Record<string, string> = {}): AskDeps {
  let t = 0
  return {
    backend,
    // sleep advances fake time AND yields to the macrotask queue, so test code
    // scheduled with setImmediate (e.g. the simulated mailbox write) can run
    // between polls. A microtask-only fake clock would starve it.
    clock: {
      now: () => t,
      sleep: async (ms) => {
        t += ms
        await new Promise((r) => setImmediate(r))
      },
    },
    fileExists: async (p) => p in files,
    readFile: async (p) => files[p],
  }
}

describe('askShell', () => {
  it('sends wrapped command and polls until sentinel appears', async () => {
    const b = fakeBackend([
      'user % ls; printf …', // poll 1: no sentinel yet
      `user % ls; printf 'x' nonce placeholder\nout.txt\n\n__termbus_${NONCE}_0__\nuser %`,
    ])
    const res = await askShell(deps(b), PANE, 'ls', NONCE, { timeoutMs: 60_000, pollMs: 1000 })
    expect(b.sent[0].text).toContain(`__termbus_${NONCE}_%s__`)
    expect(res.exitCode).toBe(0)
    expect(res.response).toContain('out.txt')
  })

  it('times out with AskTimeoutError', async () => {
    const b = fakeBackend(['user % never finishes'])
    await expect(
      askShell(deps(b), PANE, 'sleep 999', NONCE, { timeoutMs: 3000, pollMs: 1000 }),
    ).rejects.toThrow(AskTimeoutError)
  })
})

describe('askAgent', () => {
  const IDLE0 = '╭─╮\n│ > │\n╰─╯ ? for shortcuts'
  const BUSY = 'Thinking… esc to interrupt'
  const DONE = '● Answer: 42\n╭─╮\n│ > │\n╰─╯ ? for shortcuts'

  it('waits through busy then returns stable idle screen', async () => {
    const b = fakeBackend([IDLE0, BUSY, BUSY, DONE, DONE, DONE])
    const res = await askAgent(deps(b), PANE, 'claude', 'what is 6*7', NONCE, {
      timeoutMs: 600_000, pollMs: 1000, minWaitMs: 0, mailbox: false, force: false,
    })
    expect(res.response).toContain('Answer: 42')
    expect(b.sent[0].submit).toBe(true)
  })

  it('refuses to interrupt a busy agent unless forced', async () => {
    const b = fakeBackend([BUSY])
    await expect(
      askAgent(deps(b), PANE, 'claude', 'hi', NONCE, {
        timeoutMs: 1000, pollMs: 100, minWaitMs: 0, mailbox: false, force: false,
      }),
    ).rejects.toThrow(BusyPaneError)
    expect(b.sent).toHaveLength(0)
  })

  it('mailbox mode returns file contents when the file appears', async () => {
    const files: Record<string, string> = {}
    const b = fakeBackend([IDLE0, BUSY, BUSY])
    const d = deps(b, files)
    const p = askAgent(d, PANE, 'claude', 'write a poem', NONCE, {
      timeoutMs: 600_000, pollMs: 1000, minWaitMs: 0, mailbox: true, force: false,
    })
    // the sent prompt must include the mailbox path; simulate the agent writing it
    await new Promise((r) => setImmediate(r))
    const path = b.sent[0].text.match(/(\S+deadbeef1234\.md)/)![1]
    files[path] = 'full answer here'
    const res = await p
    expect(res.response).toBe('full answer here')
  })
})
