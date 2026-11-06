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
