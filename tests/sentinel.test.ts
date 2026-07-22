import { describe, expect, it } from 'vitest'
import { extractShellOutput, wrapShellCommand } from '../src/core/sentinel.js'

const NONCE = 'abc123def456'

describe('wrapShellCommand', () => {
  it('appends a printf sentinel carrying the exit code', () => {
    expect(wrapShellCommand('ls -la', NONCE)).toBe(
      `ls -la; printf '\\n__termbus_${NONCE}_%s__\\n' $?`,
    )
  })
})

describe('extractShellOutput', () => {
  it('returns null before the sentinel appears', () => {
    expect(extractShellOutput('user@host ~ % ls\nfile.txt', NONCE)).toBeNull()
  })

  it('extracts output between command echo and sentinel', () => {
    const screen = [
      'user@host ~ % ls -la; printf \'\\n__termbus_' + NONCE + '_%s__\\n\' $?',
      'total 8',
      '-rw-r--r--  1 u  staff  12 file.txt',
      '',
      `__termbus_${NONCE}_0__`,
      'user@host ~ %',
    ].join('\n')
    const res = extractShellOutput(screen, NONCE)
    expect(res).not.toBeNull()
    expect(res!.exitCode).toBe(0)
    expect(res!.output).toBe('total 8\n-rw-r--r--  1 u  staff  12 file.txt')
  })

  it('captures non-zero exit codes', () => {
    const screen = `user@host ~ % false; printf '\\n__termbus_${NONCE}_%s__\\n' $?\n\n__termbus_${NONCE}_1__\nuser@host ~ %`
    expect(extractShellOutput(screen, NONCE)!.exitCode).toBe(1)
  })

  it('handles a cleared screen with no command echo', () => {
    const screen = `some output\n\n__termbus_${NONCE}_0__`
    expect(extractShellOutput(screen, NONCE)!.output).toBe('some output')
  })
})
