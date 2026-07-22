import { describe, expect, it } from 'vitest'
import { ensureDeliverable, paneBusy, resolveMode, waitForIdle, type DeliveryDeps } from '../src/core/delivery.js'
import { AwaitingInputError, BusyPaneError, TermbusError, WaitTimeoutError } from '../src/core/errors.js'
import type { Backend, Occupant, Pane } from '../src/core/types.js'

const PANE: Pane = {
  id: 'XYZ', label: 'w1.t1.p2', title: 'worker', tty: '/dev/ttys009',
  isSelf: false, windowIndex: 1, tabIndex: 1, paneIndex: 2,
}

const IDLE_SCREEN = '╭─╮\n│ > │\n╰─╯ ? for shortcuts'
const BUSY_SCREEN = 'Thinking… esc to interrupt'

const claude = (): Occupant => ({ kind: 'claude', command: 'claude' })
const shell = (): Occupant => ({ kind: 'shell', command: null })
const command = (cmd = 'sleep 30'): Occupant => ({ kind: 'command', command: cmd })

/** Screens served in order, sticking on the last. */
function fakeBackend(screens: string[]): Backend {
  let i = -1
  return {
    name: 'fake',
    async listPanes() { return [PANE] },
    async readScreen() { i = Math.min(i + 1, screens.length - 1); return screens[i] },
    async sendText() {},
  }
}

function deps(backend: Backend, occupants?: Occupant[]): DeliveryDeps {
  let t = 0
  let o = -1
  const d: DeliveryDeps = {
    backend,
    clock: { now: () => t, sleep: async (ms) => { t += ms } },
  }
  if (occupants) {
    d.probeOccupant = async () => occupants[(o = Math.min(o + 1, occupants.length - 1))]
  }
  return d
}

describe('paneBusy', () => {
  it('agent panes use screen busy markers', () => {
    expect(paneBusy(claude(), BUSY_SCREEN)).toBe(true)
    expect(paneBusy(claude(), IDLE_SCREEN)).toBe(false)
  })
  it('a foreground command is busy; an idle shell is not', () => {
    expect(paneBusy(command(), 'anything')).toBe(true)
    expect(paneBusy(shell(), 'anything')).toBe(false)
    expect(paneBusy({ kind: 'unknown', command: null }, 'anything')).toBe(false)
  })
})

describe('resolveMode', () => {
  it('maps flags to modes and defaults to refuse', () => {
    expect(resolveMode({})).toBe('refuse')
    expect(resolveMode({ queue: true })).toBe('queue')
    expect(resolveMode({ wait: true })).toBe('wait')
    expect(resolveMode({ force: true })).toBe('force')
  })
  it('rejects combined flags', () => {
    expect(() => resolveMode({ queue: true, wait: true })).toThrow(/mutually exclusive/)
  })
})

describe('ensureDeliverable', () => {
  const opts = { timeoutMs: 10_000, pollMs: 1000 }

  it('refuse: throws on a busy agent, passes an idle one', async () => {
    await expect(
      ensureDeliverable(deps(fakeBackend([BUSY_SCREEN])), PANE, claude(), 'refuse', opts),
    ).rejects.toThrow(BusyPaneError)
    const r = await ensureDeliverable(deps(fakeBackend([IDLE_SCREEN])), PANE, claude(), 'refuse', opts)
    expect(r.outcome).toBe('idle')
  })

  it('refuse: stays permissive for shell/command panes (back-compat)', async () => {
    const r = await ensureDeliverable(deps(fakeBackend([BUSY_SCREEN])), PANE, command(), 'refuse', opts)
    expect(r.outcome).toBe('idle')
  })

  it('force: never checks the screen', async () => {
    const r = await ensureDeliverable(deps(fakeBackend([BUSY_SCREEN])), PANE, claude(), 'force', opts)
    expect(r.outcome).toBe('idle')
  })

  it('queue: busy agent with native queue → queued', async () => {
    const r = await ensureDeliverable(deps(fakeBackend([BUSY_SCREEN])), PANE, claude(), 'queue', opts)
    expect(r.outcome).toBe('queued')
  })

  it('queue: idle agent just sends normally', async () => {
    const r = await ensureDeliverable(deps(fakeBackend([IDLE_SCREEN])), PANE, claude(), 'queue', opts)
    expect(r.outcome).toBe('idle')
  })

  it('queue: busy non-queueable pane errors, pointing at --wait', async () => {
    await expect(
      ensureDeliverable(deps(fakeBackend(['x'])), PANE, command('vite dev'), 'queue', opts),
    ).rejects.toThrow(/no input queue.*--wait/)
  })

  it('wait: agent goes idle after some polls', async () => {
    const b = fakeBackend([BUSY_SCREEN, BUSY_SCREEN, BUSY_SCREEN, IDLE_SCREEN])
    const r = await ensureDeliverable(deps(b), PANE, claude(), 'wait', opts)
    expect(r.outcome).toBe('idle')
    expect(r.waitedMs).toBeGreaterThan(0)
  })

  it('wait: shell command finishing flips occupant back to shell', async () => {
    const b = fakeBackend(['irrelevant'])
    const r = await ensureDeliverable(
      deps(b, [command(), command(), shell()]),
      PANE,
      command(),
      'wait',
      opts,
    )
    expect(r.outcome).toBe('idle')
  })

  it('wait: still busy at timeout → WaitTimeoutError', async () => {
    await expect(
      ensureDeliverable(deps(fakeBackend([BUSY_SCREEN])), PANE, claude(), 'wait', { timeoutMs: 3000, pollMs: 1000 }),
    ).rejects.toThrow(WaitTimeoutError)
  })
})

describe('waitForIdle', () => {
  it('reports how long it waited', async () => {
    const b = fakeBackend([BUSY_SCREEN, BUSY_SCREEN, IDLE_SCREEN])
    const r = await waitForIdle(deps(b), PANE, claude(), { timeoutMs: 60_000, pollMs: 1000 })
    expect(r.waitedMs).toBe(3000)
  })
  it('throws TermbusError subtype on timeout', async () => {
    const err = await waitForIdle(deps(fakeBackend([BUSY_SCREEN])), PANE, claude(), {
      timeoutMs: 2000, pollMs: 1000,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(TermbusError)
    expect(err.exitCode).toBe(3)
  })
})

describe('awaiting-input handling', () => {
  const opts = { timeoutMs: 10_000, pollMs: 1000 }
  const PROMPT_SCREEN = 'Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)'

  it('refuse and queue both stop at a modal dialog', async () => {
    await expect(
      ensureDeliverable(deps(fakeBackend([PROMPT_SCREEN])), PANE, claude(), 'refuse', opts),
    ).rejects.toThrow(AwaitingInputError)
    await expect(
      ensureDeliverable(deps(fakeBackend([PROMPT_SCREEN])), PANE, claude(), 'queue', opts),
    ).rejects.toThrow(AwaitingInputError)
  })

  it('wait polls through the dialog once someone answers it', async () => {
    const b = fakeBackend([PROMPT_SCREEN, PROMPT_SCREEN, BUSY_SCREEN, IDLE_SCREEN])
    const r = await ensureDeliverable(deps(b), PANE, claude(), 'wait', opts)
    expect(r.outcome).toBe('idle')
  })

  it('force ignores the dialog', async () => {
    const r = await ensureDeliverable(deps(fakeBackend([PROMPT_SCREEN])), PANE, claude(), 'force', opts)
    expect(r.outcome).toBe('idle')
  })
})
