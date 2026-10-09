import { describe, expect, it } from 'vitest'
import { Cadence, HEARTBEAT_MS, HOT_MS, PROMPT_HOT_MS, WORK_FAST_MS, WORK_IDLE_MS, paneDigest, stableTitle } from '../src/core/cadence.js'

const pane = (over: Partial<Parameters<typeof paneDigest>[0][0]> = {}) => ({
  id: 'A',
  label: 'w1.t1.p1',
  title: '✳ Fix login',
  occupant: 'claude',
  state: 'idle',
  screen: 'x',
  ...over,
})

describe('paneDigest', () => {
  it('ignores spinner glyphs in titles and busy screen redraws', () => {
    expect(stableTitle('◐ Fix login')).toBe('Fix login')
    expect(paneDigest([pane({ title: '◐ Fix login', state: 'busy', screen: 'frame 1' })])).toBe(
      paneDigest([pane({ title: '◑ Fix login', state: 'busy', screen: 'frame 2' })]),
    )
  })
  it('changes when state, occupant, label or the set of panes changes', () => {
    const base = paneDigest([pane()])
    expect(paneDigest([pane({ state: 'busy' })])).not.toBe(base)
    expect(paneDigest([pane({ occupant: 'shell' })])).not.toBe(base)
    expect(paneDigest([pane({ label: 'w2.t1.p1' })])).not.toBe(base)
    expect(paneDigest([pane(), pane({ id: 'B' })])).not.toBe(base)
  })
  it('a waiting prompt/question: its screen matters (the phone shows it)', () => {
    expect(paneDigest([pane({ state: 'awaiting-input', screen: 'Q1' })])).not.toBe(
      paneDigest([pane({ state: 'awaiting-input', screen: 'Q2' })]),
    )
  })
  it('order of panes does not matter', () => {
    expect(paneDigest([pane(), pane({ id: 'B' })])).toBe(paneDigest([pane({ id: 'B' }), pane()]))
  })
})

describe('Cadence: sync', () => {
  it('first tick syncs; unchanged ticks do not; heartbeat after 60s', () => {
    const c = new Cadence()
    expect(c.shouldSync(0, 'd', false)).toBe(true)
    c.synced(0, 'd')
    expect(c.shouldSync(1000, 'd', false)).toBe(false)
    expect(c.shouldSync(HEARTBEAT_MS - 1, 'd', false)).toBe(false)
    expect(c.shouldSync(HEARTBEAT_MS, 'd', false)).toBe(true)
  })
  it('a change or a state event syncs immediately', () => {
    const c = new Cadence()
    c.synced(0, 'd')
    expect(c.shouldSync(1000, 'd2', false)).toBe(true)
    expect(c.shouldSync(1000, 'd', true)).toBe(true)
  })
  it('a failed sync (synced() not called) is retried next tick', () => {
    const c = new Cadence()
    expect(c.shouldSync(0, 'd', false)).toBe(true)
    expect(c.shouldSync(1000, 'd', false)).toBe(true)
  })
  it('steady state: ~1 request a minute instead of 60', () => {
    const c = new Cadence()
    let n = 0
    for (let t = 0; t < 10 * 60_000; t += 1000) {
      if (c.shouldSync(t, 'd', false)) {
        n++
        c.synced(t, 'd')
      }
    }
    expect(n).toBe(10)
  })
})

describe('Cadence: work polling', () => {
  it('idle → every 10s', () => {
    const c = new Cadence()
    expect(c.workInterval(HOT_MS + 1)).toBe(WORK_IDLE_MS)
  })
  it('a fresh prompt or recent activity → every second', () => {
    const c = new Cadence()
    c.observe(1_000_000, [{ id: 'A', state: 'awaiting-input' }], false)
    expect(c.workInterval(1_000_000 + 5000)).toBe(WORK_FAST_MS)
    // a prompt nobody answered for 10 minutes stops keeping it hot
    expect(c.workInterval(1_000_000 + PROMPT_HOT_MS + 1)).toBe(WORK_IDLE_MS)
    c.activity(2_000_000)
    expect(c.workInterval(2_000_000 + HOT_MS - 1)).toBe(WORK_FAST_MS)
    expect(c.workInterval(2_000_000 + HOT_MS)).toBe(WORK_IDLE_MS)
  })
  it('a prompt that clears and reappears is fresh again', () => {
    const c = new Cadence()
    c.observe(0, [{ id: 'A', state: 'awaiting-input' }], false)
    c.observe(PROMPT_HOT_MS + 1, [{ id: 'A', state: 'idle' }], false)
    c.observe(PROMPT_HOT_MS + 2, [{ id: 'A', state: 'awaiting-input' }], false)
    expect(c.workInterval(PROMPT_HOT_MS + 3)).toBe(WORK_FAST_MS)
  })
  it('shouldPollWork honours the interval', () => {
    const c = new Cadence()
    const t0 = HOT_MS * 10
    expect(c.shouldPollWork(t0)).toBe(true)
    c.polledWork(t0)
    expect(c.shouldPollWork(t0 + 5000)).toBe(false)
    expect(c.shouldPollWork(t0 + WORK_IDLE_MS)).toBe(true)
  })
})
