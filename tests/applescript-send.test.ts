import { describe, expect, it } from 'vitest'
import { AppleScriptBackend } from '../src/backends/applescript.js'
import { TermbusError } from '../src/core/errors.js'

/** Fake osascript: records (payload, newline) per write attempt; `fail` decides per call whether to throw -1719. */
function runner(fail: (call: number, args: string[]) => boolean) {
  const calls: string[][] = []
  const run = async (_script: string, args: string[]) => {
    calls.push(args)
    if (fail(calls.length, args)) throw new TermbusError('osascript failed: execution error: iTerm got an error: Invalid index. (-1719)')
    return 'ok'
  }
  return { calls, run }
}

describe('AppleScriptBackend.sendText (finding 1: no doubled messages)', () => {
  it('writes the text once and the Enter separately, both resolved by session id', async () => {
    const r = runner(() => false)
    await new AppleScriptBackend(null, r.run).sendText('S1', 'hello', true)
    expect(r.calls).toEqual([
      ['S1', 'hello', '0'],
      ['S1', '', '1'],
    ])
  })

  it('a -1719 while sending Enter retries ONLY the Enter — the text is never re-sent', async () => {
    const r = runner((n) => n === 2) // the Enter write fails once (tab closed mid-walk)
    await new AppleScriptBackend(null, r.run).sendText('S1', 'hello', true)
    expect(r.calls.filter((a) => a[1] === 'hello')).toHaveLength(1)
    expect(r.calls).toEqual([
      ['S1', 'hello', '0'],
      ['S1', '', '1'],
      ['S1', '', '1'],
    ])
  })

  it('a -1719 before the text was written is retried (nothing was written yet)', async () => {
    const r = runner((n) => n === 1)
    await new AppleScriptBackend(null, r.run).sendText('S1', 'hi', false)
    expect(r.calls).toEqual([
      ['S1', 'hi', '0'],
      ['S1', 'hi', '0'],
    ])
  })
})
