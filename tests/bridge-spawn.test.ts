import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeSpawn, type SpawnContext } from '../src/commands/bridge.js'
import { SpawnLimiter } from '../src/core/spawn.js'
import type { Backend, Pane } from '../src/core/types.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'termbus-spawn-'))
  process.env.HOME = home
  mkdirSync(join(home, 'proj'))
})

function fakeBackend() {
  const panes: Pane[] = []
  const calls: string[] = []
  let n = 0
  const make = (kind: string, opts?: { command?: string }) => {
    const id = `P${++n}`
    calls.push(`${kind}:${opts?.command ? 'cmd' : 'none'}`)
    panes.push({ id, label: `w1.t${n}.p1`, title: '', tty: '/dev/ttys0', isSelf: false, windowIndex: 1, tabIndex: n, paneIndex: 1 })
    return id
  }
  const b: Backend = {
    name: 'fake',
    listPanes: async () => panes,
    readScreen: async () => '',
    sendText: async () => {
      throw new Error('spawn must never type into a pane')
    },
    setPaneName: async (id, name) => void calls.push(`name:${id}:${name}`),
    createWindow: async (o) => make('window', o),
    createTab: async (_near, o) => make('tab', o),
  }
  return { b, calls, panes }
}

const ctx = (): SpawnContext => ({ limiter: new SpawnLimiter(), anchorPaneId: null })
const payload = (o: object) => JSON.stringify(o)

describe('executeSpawn', () => {
  it('first spawn opens a window running a launch script, then names it; later spawns open tabs there', async () => {
    const { b, calls } = fakeBackend()
    const c = ctx()
    const r1 = await executeSpawn(b, { id: 1, payload: payload({ agent: 'claude', cwd: join(home, 'proj'), name: 'API', prompt: 'fix tests' }) }, c)
    expect(r1).toEqual({ status: 'done', outcome: 'P1' })
    const r2 = await executeSpawn(b, { id: 2, payload: payload({ agent: 'codex', cwd: join(home, 'proj') }) }, c)
    expect(r2).toEqual({ status: 'done', outcome: 'P2' })
    expect(calls).toEqual(['window:cmd', 'name:P1:API', 'tab:cmd'])
    const script = readFileSync(join(home, '.termbus', 'launch', 'spawn-1.sh'), 'utf8')
    expect(script).toContain("&& claude 'fix tests'")
    expect(script).not.toMatch(/dangerously|--yolo/)
  })

  it('a closed anchor window → a new window', async () => {
    const { b, calls, panes } = fakeBackend()
    const c = ctx()
    await executeSpawn(b, { id: 1, payload: payload({ agent: 'codex', cwd: join(home, 'proj') }) }, c)
    panes.length = 0 // user closed it
    await executeSpawn(b, { id: 2, payload: payload({ agent: 'codex', cwd: join(home, 'proj') }) }, c)
    expect(calls).toEqual(['window:cmd', 'window:cmd'])
  })

  it('invalid requests fail without creating anything', async () => {
    const { b, calls } = fakeBackend()
    for (const p of [
      payload({ agent: 'bash', cwd: join(home, 'proj') }),
      payload({ agent: 'claude', cwd: '/etc' }),
      payload({ agent: 'claude', cwd: join(home, 'missing') }),
      'not json',
    ]) {
      expect((await executeSpawn(b, { id: 9, payload: p }, ctx())).status).toBe('failed')
    }
    expect(calls).toEqual([])
    expect(() => readdirSync(join(home, '.termbus', 'launch'))).toThrow()
  })

  it('rate limit: the 6th spawn in 10 minutes fails', async () => {
    const { b } = fakeBackend()
    const c = ctx()
    for (let i = 1; i <= 5; i++) {
      expect((await executeSpawn(b, { id: i, payload: payload({ agent: 'codex', cwd: join(home, 'proj') }) }, c, 1000 * i)).status).toBe('done')
    }
    const r = await executeSpawn(b, { id: 6, payload: payload({ agent: 'codex', cwd: join(home, 'proj') }) }, c, 7000)
    expect(r).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/limit/) })
  })
})
