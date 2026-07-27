import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverSessions } from '../src/transcripts/resolver.js'

const claudeFixture = join(__dirname, 'fixtures', 'claude-sample.jsonl')
const codexFixture = join(__dirname, 'fixtures', 'codex-sample.jsonl')

let dir: string
let claudeRoot: string
let codexRoot: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termbus-resolver-'))
  claudeRoot = join(dir, 'claude-projects')
  codexRoot = join(dir, 'codex-sessions')
  mkdirSync(join(claudeRoot, '-Users-u-project'), { recursive: true })
  mkdirSync(join(codexRoot, '2026', '07', '22'), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('discoverSessions', () => {
  it('finds sessions in both roots, extracts cwd, sorts newest first', async () => {
    const claudePath = join(claudeRoot, '-Users-u-project', '9e47fe5d-0822-4936-a942-bcf7fb708e99.jsonl')
    const codexPath = join(codexRoot, '2026', '07', '22', 'rollout-2026-07-22T11-53-47-019f8a88-7746-78f1-b597-eaeed91a910b.jsonl')
    copyFileSync(claudeFixture, claudePath)
    copyFileSync(codexFixture, codexPath)
    // make the codex session the more recent one
    const now = Date.now()
    utimesSync(claudePath, new Date(now - 60_000), new Date(now - 60_000))
    utimesSync(codexPath, new Date(now), new Date(now))

    const sessions = await discoverSessions({ claudeRoot, codexRoot })
    expect(sessions.map((s) => s.agent)).toEqual(['codex', 'claude'])

    const [codex, claude] = sessions
    expect(codex.sessionId).toBe('019f8a88-7746-78f1-b597-eaeed91a910b')
    expect(codex.cwd).toBe('/Users/u/project')
    expect(claude.sessionId).toBe('9e47fe5d-0822-4936-a942-bcf7fb708e99')
    expect(claude.cwd).toBe('/Users/u/project')
    expect(claude.sizeBytes).toBeGreaterThan(0)
    expect(claude.lastActivity).toBeLessThan(codex.lastActivity)
  })

  it('excludes sessions older than the active window', async () => {
    const path = join(claudeRoot, '-Users-u-project', 'old-session.jsonl')
    copyFileSync(claudeFixture, path)
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
    utimesSync(path, old, old)

    const within = await discoverSessions({ claudeRoot, codexRoot, activeWindowMs: 4 * 60 * 60 * 1000 })
    expect(within).toHaveLength(1)
    const outside = await discoverSessions({ claudeRoot, codexRoot, activeWindowMs: 60 * 60 * 1000 })
    expect(outside).toHaveLength(0)
  })

  it('skips files over the size cap', async () => {
    const path = join(claudeRoot, '-Users-u-project', 'big.jsonl')
    copyFileSync(claudeFixture, path)
    expect(await discoverSessions({ claudeRoot, codexRoot, maxFileBytes: 100 })).toHaveLength(0)
    expect(await discoverSessions({ claudeRoot, codexRoot })).toHaveLength(1)
  })

  it('ignores non-jsonl files, subagent transcripts, and missing roots', async () => {
    writeFileSync(join(claudeRoot, '-Users-u-project', 'notes.txt'), 'hi')
    const subdir = join(claudeRoot, '-Users-u-project', 'subagents')
    mkdirSync(subdir)
    copyFileSync(claudeFixture, join(subdir, 'agent-abc123.jsonl'))
    const sessions = await discoverSessions({
      claudeRoot,
      codexRoot: join(dir, 'does-not-exist'),
    })
    expect(sessions).toHaveLength(0)
  })

  it('falls back to the filename-derived codex session id when the head is unreadable', async () => {
    const path = join(codexRoot, '2026', '07', '22', 'rollout-2026-07-22T09-00-00-aaaabbbb-cccc-dddd-eeee-ffff00001111.jsonl')
    writeFileSync(path, 'not json at all\n')
    const [session] = await discoverSessions({ claudeRoot, codexRoot })
    expect(session.sessionId).toBe('aaaabbbb-cccc-dddd-eeee-ffff00001111')
    expect(session.cwd).toBeUndefined()
  })
})
