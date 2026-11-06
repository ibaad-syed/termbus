import { describe, expect, it } from 'vitest'
import { parseTabTitlesOutput } from '../src/backends/applescript.js'
import { emptyStore, recordGeneration } from '../src/restore/store.js'
import type { SavedAgent } from '../src/restore/types.js'

const FS = String.fromCharCode(31)
const RS = String.fromCharCode(30)

const agent = (o: Partial<SavedAgent> = {}): SavedAgent => ({
  paneId: 'P1',
  windowIndex: 1,
  tabIndex: 6,
  paneIndex: 1,
  title: '✳ x',
  kind: 'claude',
  sessionId: 's1',
  cwd: '/w',
  command: 'claude',
  ...o,
})

describe('tab names', () => {
  it('parses named tabs, keeping spaces and punctuation in a name', () => {
    const raw = `1${FS}1${FS}PRIMARY${RS}1${FS}4${FS}INFRA + DB${RS}1${FS}6${FS}AUDITOR${RS}`
    expect(parseTabTitlesOutput(raw)).toEqual([
      { windowIndex: 1, tabIndex: 1, title: 'PRIMARY' },
      { windowIndex: 1, tabIndex: 4, title: 'INFRA + DB' },
      { windowIndex: 1, tabIndex: 6, title: 'AUDITOR' },
    ])
    expect(parseTabTitlesOutput('')).toEqual([])
  })

  it('a rename alone is not a new generation, but the new name is saved', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent()], tabs: [{ windowIndex: 1, tabIndex: 6, title: 'AUDIT' }], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent()], tabs: [{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }], now: 2 })
    expect(s.generations).toHaveLength(1)
    expect(s.generations[0].tabs).toEqual([{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }])
  })

  it('a snapshot whose tab read failed keeps the names saved before', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent()], tabs: [{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent()], now: 2 })
    expect(s.generations[0].tabs).toEqual([{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }])
  })

  it('a new generation carries the current names', () => {
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent()], tabs: [{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }], now: 1 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 's2' })], tabs: [{ windowIndex: 1, tabIndex: 6, title: 'AUDITOR' }], now: 2 })
    expect(s.generations).toHaveLength(2)
    expect(s.generations[1].tabs?.[0].title).toBe('AUDITOR')
  })
})

describe('codex pane titles', () => {
  it('reads the thread name from the pane title the Codex TUI sets', async () => {
    const { codexThreadNamesFromTitle } = await import('../src/restore/identity.js')
    expect(codexThreadNamesFromTitle('Analyze Cutdown exposure pipeline | Ponder (codex)')).toEqual(['Analyze Cutdown exposure pipeline'])
    expect(codexThreadNamesFromTitle('⠧ Analyze Cutdown exposure pipeline | Ponder (codex)')).toEqual(['Analyze Cutdown exposure pipeline'])
    expect(codexThreadNamesFromTitle('[ ! ] Action Required | Analyze Cutdown exposure pipeline | Ponder (codex)')).toContain(
      'Analyze Cutdown exposure pipeline',
    )
    expect(codexThreadNamesFromTitle('codex')).toEqual([])
  })
})

describe('retention and pins', () => {
  it('keeps the state an earlier run ended in, however many states the current run records', async () => {
    const { emptyStore, recordGeneration, pickGeneration, STABLE_MS } = await import('../src/restore/store.js')
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'before-crash' })], now: 0 })
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'before-crash' })], now: STABLE_MS })
    for (let i = 0; i < 80; i++) s = recordGeneration(s, { instance: 'B', agents: [agent({ sessionId: `b${i}` })], now: 2 * STABLE_MS + i }, 50)
    expect(s.generations.length).toBe(51)
    expect(pickGeneration(s, 'B')?.agents[0].sessionId).toBe('before-crash')
  })

  it('never prunes a pinned state', async () => {
    const { emptyStore, recordGeneration } = await import('../src/restore/store.js')
    let s = emptyStore()
    s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: 'pinned' })], now: 0 })
    s = { ...s, generations: s.generations.map((g) => ({ ...g, pinned: 'keep' })) }
    for (let i = 0; i < 80; i++) s = recordGeneration(s, { instance: 'A', agents: [agent({ sessionId: `a${i}` })], now: 1 + i }, 50)
    expect(s.generations.some((g) => g.pinned === 'keep')).toBe(true)
  })
})
