import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionTailer } from '../src/transcripts/tailer.js'
import type { SessionInfo } from '../src/transcripts/types.js'

const fixturePath = join(__dirname, 'fixtures', 'claude-sample.jsonl')
const fixtureLines = readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termbus-tailer-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeInfo(path: string): SessionInfo {
  return {
    agent: 'claude',
    sessionId: '9e47fe5d-0822-4936-a942-bcf7fb708e99',
    path,
    lastActivity: Date.now(),
    sizeBytes: 0,
  }
}

describe('SessionTailer', () => {
  it('reads incrementally as lines are appended', async () => {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, fixtureLines.slice(0, 4).join('\n') + '\n')
    const tailer = new SessionTailer(makeInfo(path))

    const first = await tailer.poll()
    expect(first.map((e) => e.kind)).toEqual(['user_msg'])
    expect(first[0].seq).toBe(3)

    expect(await tailer.poll()).toEqual([]) // nothing new

    appendFileSync(path, fixtureLines.slice(4).join('\n') + '\n')
    const rest = await tailer.poll()
    expect(rest[0].kind).toBe('thinking')
    expect(rest.filter((e) => e.kind === 'turn_done')).toHaveLength(2)
    // seq continues from the earlier poll's line count
    expect(rest[0].seq).toBe(6)
  })

  it('buffers a partial trailing line until it completes', async () => {
    const path = join(dir, 'session.jsonl')
    const line = fixtureLines[3] // the "resume" user_msg
    const cut = Math.floor(line.length / 2)
    writeFileSync(path, line.slice(0, cut))
    const tailer = new SessionTailer(makeInfo(path))

    expect(await tailer.poll()).toEqual([]) // incomplete line: buffered, not parsed

    appendFileSync(path, line.slice(cut) + '\n')
    const events = await tailer.poll()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('user_msg')
    expect(events[0].text).toBe('resume')
    expect(events[0].seq).toBe(0)
  })

  it('does not split multi-byte characters across polls', async () => {
    const path = join(dir, 'session.jsonl')
    const line = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-07-22T00:00:00.000Z',
      message: { role: 'user', content: 'héllo — ✳ done' },
    })
    const bytes = Buffer.from(line + '\n', 'utf8')
    // cut inside the multi-byte '—'
    const cut = bytes.indexOf(Buffer.from('—', 'utf8')) + 1
    writeFileSync(path, bytes.subarray(0, cut))
    const tailer = new SessionTailer(makeInfo(path))
    await tailer.poll()
    appendFileSync(path, bytes.subarray(cut))
    const [ev] = await tailer.poll()
    expect(ev.text).toBe('héllo — ✳ done')
  })

  it('detects truncation and restarts under a new epoch', async () => {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, fixtureLines.slice(0, 10).join('\n') + '\n')
    const tailer = new SessionTailer(makeInfo(path))
    const before = await tailer.poll()
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((e) => e.epoch === 0)).toBe(true)

    // rewrite the file smaller — a truncation/rewrite
    writeFileSync(path, fixtureLines.slice(0, 4).join('\n') + '\n')
    const after = await tailer.poll()
    expect(after.map((e) => e.kind)).toEqual(['user_msg'])
    expect(after[0].epoch).toBe(1)
    expect(after[0].seq).toBe(3) // seq restarted with the new epoch
  })

  it('returns [] when the file is missing', async () => {
    const tailer = new SessionTailer(makeInfo(join(dir, 'gone.jsonl')))
    expect(await tailer.poll()).toEqual([])
  })

  it('getState/initialState resume across instances (process restarts)', async () => {
    const path = join(dir, 'session.jsonl')
    const head = fixtureLines.slice(0, 4).join('\n') + '\n'
    writeFileSync(path, head)
    const first = new SessionTailer(makeInfo(path))
    await first.poll()
    const state = first.getState()
    expect(state).toEqual({ offset: Buffer.byteLength(head), epoch: 0, lineNo: 4 })

    // "restart": a fresh instance restored from persisted state
    appendFileSync(path, fixtureLines.slice(4).join('\n') + '\n')
    const second = new SessionTailer(makeInfo(path), { initialState: state })
    const rest = await second.poll()
    expect(rest[0].kind).toBe('thinking')
    expect(rest[0].seq).toBe(6) // lineNo carried over — no seq collision
    expect(rest.every((e) => e.epoch === 0)).toBe(true)
  })

  it('increments epoch from the RESTORED value on truncation', async () => {
    const path = join(dir, 'session.jsonl')
    const head = fixtureLines.slice(0, 10).join('\n') + '\n'
    writeFileSync(path, head)
    // a prior generation already went through 5 truncations
    const tailer = new SessionTailer(makeInfo(path), {
      initialState: { offset: Buffer.byteLength(head), epoch: 5, lineNo: 10 },
    })
    expect(await tailer.poll()).toEqual([]) // caught up

    writeFileSync(path, fixtureLines.slice(0, 4).join('\n') + '\n') // shrink
    const after = await tailer.poll()
    expect(after.map((e) => e.kind)).toEqual(['user_msg'])
    expect(after[0].epoch).toBe(6) // 5 + 1, not reset to 1
    expect(tailer.getState().epoch).toBe(6)
  })

  it('getState offset never includes a partial trailing line', async () => {
    const path = join(dir, 'session.jsonl')
    const line = fixtureLines[3]
    writeFileSync(path, line + '\n' + line.slice(0, 20))
    const tailer = new SessionTailer(makeInfo(path))
    const events = await tailer.poll()
    expect(events).toHaveLength(1)
    const state = tailer.getState()
    expect(state.offset).toBe(Buffer.byteLength(line) + 1) // stops at the newline
    // a restored instance picks the partial line up once it completes
    appendFileSync(path, line.slice(20) + '\n')
    const resumed = new SessionTailer(makeInfo(path), { initialState: state })
    const next = await resumed.poll()
    expect(next).toHaveLength(1)
    expect(next[0].seq).toBe(1)
  })
})
