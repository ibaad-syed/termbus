import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { detectBackend } from '../backends/detect.js'
import { askAgent, askShell, defaultClock, type AskDeps } from '../core/ask.js'
import { TermbusError } from '../core/errors.js'
import { occupantForTty } from '../core/occupant.js'
import { resolveTarget } from '../core/resolve.js'
import type { AgentKind, AskResult, Backend, Pane } from '../core/types.js'

function makeDeps(backend: Backend): AskDeps {
  return {
    backend,
    clock: defaultClock,
    fileExists: async (p) => existsSync(p),
    readFile: (p) => readFile(p, 'utf8'),
  }
}

function nonce(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

async function askPane(
  deps: AskDeps,
  panes: Pane[],
  target: string,
  prompt: string,
  opts: { timeoutMs: number; mailbox: boolean; force: boolean },
): Promise<AskResult> {
  const pane = resolveTarget(panes, target)
  if (pane.isSelf) throw new TermbusError('refusing to ask self (this pane) — would deadlock')
  const occ = await occupantForTty(pane.tty)
  if (occ.kind === 'shell') {
    return askShell(deps, pane, prompt, nonce(), { timeoutMs: opts.timeoutMs, pollMs: 1000 })
  }
  if (occ.kind === 'claude' || occ.kind === 'codex') {
    return askAgent(deps, pane, occ.kind as AgentKind, prompt, nonce(), {
      timeoutMs: opts.timeoutMs,
      pollMs: 1000,
      minWaitMs: 3000,
      mailbox: opts.mailbox,
      force: opts.force,
    })
  }
  throw new TermbusError(
    `pane ${pane.label} is running "${occ.command ?? 'unknown'}" — ask supports shell/claude/codex panes; use \`termbus send --raw\` for other TUIs`,
  )
}

export async function cmdAsk(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      timeout: { type: 'string' },
      mailbox: { type: 'boolean' },
      force: { type: 'boolean' },
      batch: { type: 'string' },
    },
    allowPositionals: true,
  })
  const timeoutMs = (values.timeout ? Number(values.timeout) : 60) * 1000
  const opts = { timeoutMs, mailbox: Boolean(values.mailbox), force: Boolean(values.force) }
  const backend = detectBackend()
  const deps = makeDeps(backend)
  const panes = await backend.listPanes()

  if (values.batch) {
    let map: Record<string, string>
    try {
      map = JSON.parse(values.batch) as Record<string, string>
    } catch {
      throw new TermbusError('--batch expects a JSON object of {"target": "prompt"}')
    }
    const results = await Promise.all(
      Object.entries(map).map(async ([name, prompt]) => {
        try {
          const r = await askPane(deps, panes, name, prompt, opts)
          return { name, output: r.response, exitCode: r.exitCode }
        } catch (err) {
          return { name, error: err instanceof Error ? err.message : String(err) }
        }
      }),
    )
    console.log(JSON.stringify(results, null, 2))
    return
  }

  const [target, ...promptParts] = positionals
  const prompt = promptParts.join(' ')
  if (!target || !prompt) {
    throw new TermbusError('usage: termbus ask <target> <prompt> [--timeout S] [--mailbox] [--force] | termbus ask --batch <json>')
  }
  const res = await askPane(deps, panes, target, prompt, opts)
  console.log(res.response)
  if (res.kind === 'shell' && res.exitCode !== 0) {
    console.error(`[exit ${res.exitCode}]`)
    process.exitCode = 1
  }
}
