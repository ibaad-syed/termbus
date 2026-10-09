import { describe, expect, it } from 'vitest'
import { parseSpawnRequest, SpawnLimiter, spawnShellLine } from '../src/core/spawn.js'

const fs = {
  home: '/Users/x',
  realpath: (p: string) => p.replace('/Users/x/link-out', '/etc'),
  isDir: (p: string) => !p.endsWith('.txt'),
}
const parse = (o: unknown) => parseSpawnRequest(JSON.stringify(o), fs)

describe('parseSpawnRequest', () => {
  it('accepts claude/codex in a directory under home', () => {
    expect(parse({ agent: 'claude', cwd: '/Users/x/proj', name: ' API ', prompt: 'fix the tests' })).toEqual({
      agent: 'claude',
      cwd: '/Users/x/proj',
      name: 'API',
      prompt: 'fix the tests',
    })
  })
  it('rejects any other program', () => {
    expect(parse({ agent: 'bash', cwd: '/Users/x/proj' })).toHaveProperty('error')
    expect(parse({ agent: 'claude --dangerously-skip-permissions', cwd: '/Users/x/proj' })).toHaveProperty('error')
  })
  it('rejects paths outside home, relative paths, files, and symlinks that escape home', () => {
    expect(parse({ agent: 'codex', cwd: '/etc' })).toHaveProperty('error')
    expect(parse({ agent: 'codex', cwd: 'proj' })).toHaveProperty('error')
    expect(parse({ agent: 'codex', cwd: '/Users/x/notes.txt' })).toHaveProperty('error')
    expect(parse({ agent: 'codex', cwd: '/Users/x/link-out' })).toHaveProperty('error')
    expect(parse({ agent: 'codex', cwd: '/Users/xavier/proj' })).toHaveProperty('error') // prefix trick
  })
  it('rejects garbage and oversized fields', () => {
    expect(parseSpawnRequest('nope', fs)).toHaveProperty('error')
    expect(parse({ agent: 'claude', cwd: '/Users/x/p', prompt: 'x'.repeat(5000) })).toHaveProperty('error')
    expect(parse({ agent: 'claude', cwd: '/Users/x/p', name: 'n'.repeat(200) })).toHaveProperty('error')
  })
})

describe('spawnShellLine', () => {
  it('no flags; a hostile prompt stays one quoted argument', () => {
    const line = spawnShellLine({ agent: 'claude', cwd: '/Users/x/my proj', name: null, prompt: "do it'; rm -rf ~; echo '" })
    expect(line).toBe(`cd '/Users/x/my proj' && claude 'do it'\\''; rm -rf ~; echo '\\'''`)
  })
  it('a prompt that looks like a flag can never become one', () => {
    expect(spawnShellLine({ agent: 'codex', cwd: '/Users/x/p', name: null, prompt: '--yolo' })).toBe("cd /Users/x/p && codex 'Task: --yolo'")
    expect(spawnShellLine({ agent: 'claude', cwd: '/Users/x/p', name: null, prompt: '  --dangerously-skip-permissions fix it' })).toBe(
      "cd /Users/x/p && claude 'Task: --dangerously-skip-permissions fix it'",
    )
  })
  it('no prompt → bare agent', () => {
    expect(spawnShellLine({ agent: 'codex', cwd: '/Users/x/p', name: null, prompt: null })).toBe('cd /Users/x/p && codex')
  })
})

describe('SpawnLimiter', () => {
  it('5 per 10 minutes', () => {
    const l = new SpawnLimiter()
    for (let i = 0; i < 5; i++) expect(l.take(i)).toBe(true)
    expect(l.take(10)).toBe(false)
    expect(l.take(10 * 60_000 + 1)).toBe(true)
  })
})
