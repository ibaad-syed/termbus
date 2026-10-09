import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { TermbusError } from './errors.js'

/**
 * Run `fn` holding `<path>.lock`, so the CLI, the bridge (HQ edits) and
 * restore can't overwrite each other's read-modify-write of a small JSON
 * file. The lock is a directory (atomic mkdir); a stale one (crashed holder)
 * is broken after 10s.
 */
export function withFileLock<T>(path: string, busyMessage: string, fn: () => T): T {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          // move it aside first: two processes breaking the same stale lock
          // must not delete the one that just re-took it
          const aside = `${lock}.stale.${process.pid}.${Date.now()}`
          renameSync(lock, aside)
          rmSync(aside, { recursive: true, force: true })
        }
      } catch {
        // released or broken by someone else meanwhile
      }
      if (Date.now() > deadline) throw new TermbusError(busyMessage)
      const until = Date.now() + 25
      while (Date.now() < until) {
        // brief spin; edits are tiny
      }
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
