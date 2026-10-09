import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeExec } from '../src/commands/bridge.js'

let home: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'termbus-exec-home-')))
  process.env.HOME = home
  mkdirSync(join(home, 'proj'))
})
const p = (o: object) => ({ payload: JSON.stringify(o) })

describe('executeExec', () => {
  it('read-only argv runs and returns structured output', async () => {
    const r = await executeExec(p({ argv: ['ls'], cwd: home }), false)
    expect(r.status).toBe('done')
    expect(JSON.parse(r.outcome!)).toMatchObject({ exitCode: 0, stdout: 'proj\n' })
  })
  it('a non-allowlisted argv fails without running', async () => {
    const r = await executeExec(p({ argv: ['touch', 'pwned'], cwd: home }), true)
    expect(r.status).toBe('failed')
    expect(() => realpathSync(join(home, 'pwned'))).toThrow()
  })
  it('user-approved shell command runs', async () => {
    const r = await executeExec(p({ command: 'echo hi | tr a-z A-Z', cwd: join(home, 'proj'), approved: 'user' }), false)
    expect(JSON.parse(r.outcome!)).toMatchObject({ exitCode: 0, stdout: 'HI\n' })
  })
  it('auto-approved shell command: refused unless this Mac allowed it', async () => {
    const refused = await executeExec(p({ command: 'touch made', cwd: home, approved: 'auto' }), false)
    expect(refused).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/allow-auto-exec/) })
    expect(() => realpathSync(join(home, 'made'))).toThrow()
    const ok = await executeExec(p({ command: 'touch made', cwd: home, approved: 'auto' }), true)
    expect(ok.status).toBe('done')
    expect(realpathSync(join(home, 'made'))).toBeTruthy()
  })
  it('outside home → refused', async () => {
    expect((await executeExec(p({ argv: ['ls'], cwd: '/etc' }), true)).status).toBe('failed')
  })
})
