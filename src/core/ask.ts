import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskTimeoutError, BusyPaneError } from './errors.js'
import { looksBusy } from './idle.js'
import { extractShellOutput, wrapShellCommand } from './sentinel.js'
import type { AgentKind, AskResult, Backend, Pane } from './types.js'

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export interface AskDeps {
  backend: Backend
  clock: Clock
  fileExists(path: string): Promise<boolean>
  readFile(path: string): Promise<string>
}

export interface ShellAskOptions {
  timeoutMs: number
  pollMs: number
}

export interface AgentAskOptions extends ShellAskOptions {
  minWaitMs: number // don't accept idle before this much time has passed
  mailbox: boolean
  force: boolean
}

export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

export function mailboxPath(nonce: string): string {
  return join(tmpdir(), 'termbus', `${nonce}.md`)
}

export async function askShell(
  deps: AskDeps,
  pane: Pane,
  cmd: string,
  nonce: string,
  opts: ShellAskOptions,
): Promise<AskResult> {
  await deps.backend.sendText(pane.id, wrapShellCommand(cmd, nonce), true)
  const start = deps.clock.now()
  let last = ''
  while (deps.clock.now() - start < opts.timeoutMs) {
    await deps.clock.sleep(opts.pollMs)
    last = await deps.backend.readScreen(pane.id)
    const res = extractShellOutput(last, nonce)
    if (res) return { kind: 'shell', response: res.output, exitCode: res.exitCode, screen: last }
  }
  throw new AskTimeoutError(pane, last)
}

export async function askAgent(
  deps: AskDeps,
  pane: Pane,
  kind: AgentKind,
  prompt: string,
  nonce: string,
  opts: AgentAskOptions,
): Promise<AskResult> {
  const before = await deps.backend.readScreen(pane.id)
  if (looksBusy(kind, before) && !opts.force) throw new BusyPaneError(pane, before)

  let toSend = prompt
  let mailbox: string | null = null
  if (opts.mailbox) {
    mailbox = mailboxPath(nonce)
    toSend =
      `${prompt} — IMPORTANT: when you are completely finished, write your full final answer ` +
      `to the file ${mailbox} (create parent directories if needed).`
  }
  await deps.backend.sendText(pane.id, toSend, true)

  const start = deps.clock.now()
  let prev: string | null = null
  let stable = 0
  let last = before
  while (deps.clock.now() - start < opts.timeoutMs) {
    await deps.clock.sleep(opts.pollMs)
    if (mailbox && (await deps.fileExists(mailbox))) {
      await deps.clock.sleep(500) // let the write settle
      const response = await deps.readFile(mailbox)
      return { kind: 'agent', response, screen: await deps.backend.readScreen(pane.id) }
    }
    const screen = await deps.backend.readScreen(pane.id)
    last = screen
    if (!mailbox) {
      const busy = looksBusy(kind, screen)
      if (!busy && screen !== before && screen === prev) stable++
      else stable = 0
      if (stable >= 2 && deps.clock.now() - start >= opts.minWaitMs) {
        return { kind: 'agent', response: screen, screen }
      }
    }
    prev = screen
  }
  throw new AskTimeoutError(pane, last)
}
