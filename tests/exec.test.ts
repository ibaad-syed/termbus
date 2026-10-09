import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execEnv, gitConfigRisk, hardenGit, redactSecrets, parseExecRequest, readOnlyViolation, riskyLocalGitConfig, runExec } from '../src/core/exec.js'

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
    [['lsof', '-n']], // no -i: would list every open file
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
      'git', '--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=',
      '-c', 'log.showSignature=false', '-c', 'gpg.program=false', 'diff', '--no-ext-diff', '--no-textconv', '--stat',
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
  it('shell command only when approved by the user AND this Mac allows commands', () => {
    const ok = (o: object) => parseExecRequest(JSON.stringify(o), { ...fs, allowExec: true })
    expect(ok({ command: 'npm test', cwd: '/Users/x/p' })).toHaveProperty('error')
    expect(ok({ command: 'npm test', cwd: '/Users/x/p', approved: 'yes' })).toHaveProperty('error')
    expect(ok({ command: 'npm test', cwd: '/Users/x/p', approved: 'user' })).toEqual({ kind: 'shell', command: 'npm test', cwd: '/Users/x/p', approvedBy: 'user' })
    expect(ok({ command: 'npm test', cwd: '/Users/x/p', approved: true })).toMatchObject({ approvedBy: 'user' })
    // a stolen HQ session can tap Approve — without the local opt-in it still fails
    expect(parse({ command: 'npm test', cwd: '/Users/x/p', approved: 'user' })).toEqual({ error: expect.stringMatching(/--allow-exec/) })
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

describe('riskyLocalGitConfig', () => {
  it('flags repo-local keys that run programs; trusts global/system', () => {
    const listing = [
      'global\tfilter.lfs.clean=git-lfs clean -- %f',
      'global\tcore.pager=less',
      'local\tcore.bare=false',
      'local\tremote.origin.url=https://github.com/x/y',
    ].join('\n')
    expect(riskyLocalGitConfig(listing)).toBeNull()
    expect(riskyLocalGitConfig(listing + '\nlocal\tfilter.x.clean=sh -c pwn')).toBe('filter.x.clean')
    expect(riskyLocalGitConfig('local\tdiff.evil.textconv=./run')).toBe('diff.evil.textconv')
    expect(riskyLocalGitConfig('worktree\tcore.fsmonitor=./hook')).toBe('core.fsmonitor')
    expect(riskyLocalGitConfig('local\tgpg.program=./x')).toBe('gpg.program')
    expect(riskyLocalGitConfig('local\tinclude.path=../evil.cfg')).toBe('include.path')
  })
})

describe('gitConfigRisk + real git (the reviewer\'s reproduction)', () => {
  it('a repo with a clean filter in .git/config is not read-only', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const repo = mkdtempSync(join(tmpdir(), 'termbus-gitrisk-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    expect(await gitConfigRisk(repo)).toBeNull()
    execFileSync('git', ['config', 'filter.x.clean', 'touch PWNED'], { cwd: repo })
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n')
    expect(await gitConfigRisk(repo)).toBe('filter.x.clean')
  })
})

describe('git signature options', () => {
  it('blocked', () => {
    expect(readOnlyViolation(['git', 'log', '--show-signature'])).not.toBeNull()
    expect(readOnlyViolation(['git', 'log', '--format=%G?'])).not.toBeNull()
  })
})

describe('redactSecrets', () => {
  it('masks credentials in URLs, flags, assignments, bearer tokens and known key shapes', () => {
    expect(redactSecrets('origin\thttps://bob:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/x/y (fetch)')).toBe('origin\thttps://bob:***@github.com/x/y (fetch)')
    expect(redactSecrets('https://x-access-token-abcdefghijklmnop@github.com/x')).toBe('https://***@github.com/x')
    expect(redactSecrets('node cli.js bridge --relay https://hq --secret tb_live_123456')).toBe('node cli.js bridge --relay https://hq --secret ***')
    expect(redactSecrets('OPENAI_API_KEY=sk-proj-abc123 FOO=bar')).toBe('OPENAI_API_KEY=*** FOO=bar')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer ***')
    expect(redactSecrets('key sk-ant-api03-abcdefghijklmnopqrst here')).toBe('key sk_*** here')
  })
  it('leaves ordinary output alone', () => {
    const ps = '  501 81234 ttys003  claude --resume 65392c89-c895-439b-be3c-c5e8be7296a0 --dangerously-skip-permissions'
    expect(redactSecrets(ps)).toBe(ps)
    expect(redactSecrets('https://github.com/x/y.git')).toBe('https://github.com/x/y.git')
  })
})

describe('execEnv', () => {
  it('drops TERMBUS_* (the bridge secret) from commands', () => {
    const env = execEnv({ PATH: '/bin', TERMBUS_BRIDGE_SECRET: 's', HOME: '/h' })
    expect(env.TERMBUS_BRIDGE_SECRET).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
})

describe('runExec timeout kills the process group', () => {
  it('a background child of a timed-out command dies with it', async () => {
    const { readFileSync } = await import('node:fs')
    const dir = mkdtempSync(join(tmpdir(), 'termbus-pg-'))
    const r = await runExec(
      { kind: 'shell', command: 'sleep 30 & echo $! > child.pid; wait', cwd: dir, approvedBy: 'user' },
      '/bin/sh',
      { timeoutMs: 500 },
    )
    expect(r.timedOut).toBe(true)
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'))
    await new Promise((res) => setTimeout(res, 300))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)
})
