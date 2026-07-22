import { describe, expect, it } from 'vitest'
import { extractShellOutput, wrapShellCommand } from '../src/core/sentinel.js'

const NONCE = 'abc123def456'

describe('wrapShellCommand', () => {
  it('brackets the command with begin/end printf markers carrying the exit code', () => {
    expect(wrapShellCommand('ls -la', NONCE)).toBe(
      `printf '\\n__termbus_${NONCE}_begin__\\n'; ls -la; printf '\\n__termbus_${NONCE}_%s__\\n' $?`,
    )
  })
})

describe('extractShellOutput', () => {
  it('returns null before the end marker appears', () => {
    expect(extractShellOutput('user@host ~ % ls\nfile.txt', NONCE)).toBeNull()
  })

  it('extracts output between begin and end markers', () => {
    const screen = [
      "user@host ~ % printf '\\n__termbus_" +
        NONCE +
        "_begin__\\n'; ls -la; printf '\\n__termbus_" +
        NONCE +
        "_%s__\\n' $?",
      `__termbus_${NONCE}_begin__`,
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
    const screen = [
      `user@host ~ % printf '\\n__termbus_${NONCE}_begin__\\n'; false; printf '\\n__termbus_${NONCE}_%s__\\n' $?`,
      `__termbus_${NONCE}_begin__`,
      '',
      `__termbus_${NONCE}_1__`,
      'user@host ~ %',
    ].join('\n')
    expect(extractShellOutput(screen, NONCE)!.exitCode).toBe(1)
  })

  it('ignores an echoed command that wrapped across screen lines', () => {
    // Narrow split pane: the echoed command wraps mid-nonce onto a second
    // screen line. The old command-echo heuristic prepended that junk; the
    // begin marker (always at column 0) fences it out.
    const screen = [
      `user@host ~ % printf '\\n__termbus_${NONCE.slice(0, 6)}`,
      `${NONCE.slice(6)}_begin__\\n'; ls; printf '\\n__termbus_${NONCE}_%s__\\n' $?`,
      `__termbus_${NONCE}_begin__`,
      'file-a.txt',
      'file-b.txt',
      '',
      `__termbus_${NONCE}_0__`,
      'user@host ~ %',
    ].join('\n')
    const res = extractShellOutput(screen, NONCE)
    expect(res).not.toBeNull()
    expect(res!.output).toBe('file-a.txt\nfile-b.txt')
  })

  it('falls back to visible top when the begin marker scrolled off', () => {
    const screen = `some output\n\n__termbus_${NONCE}_0__`
    expect(extractShellOutput(screen, NONCE)!.output).toBe('some output')
  })
})
