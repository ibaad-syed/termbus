import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hardenGit, parseExecRequest, readOnlyViolation, runExec } from '../src/core/exec.js'

describe('readOnlyViolation', () => {
  it.each([
    [['ps', 'aux']],
    [['ps', '-ax', '-o', 'pid,command']],
    [['ls', '-la']],
    [['df', '-h']],
    [['du', '-sh', '.']],
    [['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']],
    [['git', 'status']],
    [['git', 'log', '--oneline', '-5']],
    [['git', 'diff', '--stat']],
    [['git', 'remote', '-v']],
    [['git', 'branch', '-a']],
  ])('allows %j', (argv) => expect(readOnlyViolation(argv)).toBeNull())

  it.each([
    [['rm', '-rf', '/']],
    [['cat', '/Users/x/.ssh/id_rsa']],
    [['bash', '-c', 'echo hi']],
    [['ps', 'eww']], // env vars of every process
    [['ps', '-E']],
    [['ps', '-e']],
    [['lsof', '/Users/x/file']],
    [['git', 'push']],
    [['git', 'remote', 'add', 'x', 'y']],
    [['git', 'branch', '-D', 'main']],
    [['git', 'diff', '--no-index', '/Users/x/.ssh/id_rsa', '/dev/null']],
    [['git', 'diff', '--output=/tmp/x']],
    [['git', 'show', 'HEAD:.env']],
    [['git', '-c', 'core.pager=sh', 'log']],
    [['git', '-C', '/', 'status']],
    [[]],
  ])('refuses %j', (argv) => expect(readOnlyViolation(argv)).not.toBeNull())
})

describe('hardenGit', () => {
  it('turns off pagers, fsmonitor, external diff and textconv', () => {
    expect(hardenGit(['git', 'diff', '--stat'])).toEqual([
      'git', '--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', '--stat',
    ])
    expect(hardenGit(['ps', 'aux'])).toEqual(['ps', 'aux'])
  })
})

describe('parseExecRequest', () => {
  const fs = { home: '/Users/x', realpath: (p: string) => p, isDir: () => true }
  const parse = (o: object) => parseExecRequest(JSON.stringify(o), fs)
  it('argv on the list → runs (git hardened)', () => {
    expect(parse({ argv: ['git', 'status'], cwd: '/Users/x/p' })).toMatchObject({ kind: 'argv', argv: expect.arrayContaining(['--no-pager', 'status']) })
  })
  it('argv off the list → refused, even if marked approved (approved commands use the shell form)', () => {
    expect(parse({ argv: ['rm', '-rf', 'x'], cwd: '/Users/x/p', approved: true })).toHaveProperty('error')
  })
  it('shell command only when approved by the user', () => {
    expect(parse({ command: 'npm test', cwd: '/Users/x/p' })).toHaveProperty('error')
    expect(parse({ command: 'npm test', cwd: '/Users/x/p', approved: 'yes' })).toHaveProperty('error')
    expect(parse({ command: 'npm test', cwd: '/Users/x/p', approved: 'user' })).toEqual({ kind: 'shell', command: 'npm test', cwd: '/Users/x/p', approvedBy: 'user' })
    expect(parse({ command: 'npm test', cwd: '/Users/x/p', approved: true })).toMatchObject({ approvedBy: 'user' })
  })
  it('Full auto needs this Mac to opt in locally', () => {
    expect(parse({ command: 'npm test', cwd: '/Users/x/p', approved: 'auto' })).toEqual({ error: expect.stringMatching(/allow-auto-exec/) })
    expect(parseExecRequest(JSON.stringify({ command: 'npm test', cwd: '/Users/x/p', approved: 'auto' }), { ...fs, allowAutoExec: true })).toMatchObject({
      kind: 'shell',
      approvedBy: 'auto',
    })
  })
  it('cwd must be absolute and inside home', () => {
    expect(parse({ argv: ['ls'], cwd: '/etc' })).toHaveProperty('error')
    expect(parse({ argv: ['ls'], cwd: 'p' })).toHaveProperty('error')
    expect(parse({ argv: ['ls'], cwd: '/Users/xavier' })).toHaveProperty('error')
  })
})

describe('runExec (real processes, no shell for argv)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'termbus-exec-'))
  mkdirSync(join(dir, 'sub'))
  it('argv: runs without a shell — metacharacters are just arguments', async () => {
    const r = await runExec({ kind: 'argv', argv: ['ls', '; echo pwned'], cwd: dir }, '/bin/zsh')
    expect(r.stdout).not.toContain('pwned')
    expect(r.exitCode).not.toBe(0)
  })
  it('argv: output and exit code', async () => {
    const r = await runExec({ kind: 'argv', argv: ['ls'], cwd: dir }, '/bin/zsh')
    expect(r).toMatchObject({ exitCode: 0, stdout: 'sub\n', truncated: false, timedOut: false })
  })
  it('shell (approved): pipes work, output is capped', async () => {
    const r = await runExec({ kind: 'shell', command: 'yes x | head -c 40000', cwd: dir, approvedBy: 'user' }, '/bin/sh')
    expect(r.exitCode).toBe(0)
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(16 * 1024)
  })
})
