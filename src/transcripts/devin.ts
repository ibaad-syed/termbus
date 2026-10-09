import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TailerState } from './tailer.js'
import type { SessionInfo, TranscriptEvent } from './types.js'
import { MAX_THINKING_CHARS, MAX_TOOL_INPUT_CHARS, truncate } from './types.js'

const execFileP = promisify(execFile)

/**
 * Devin CLI sessions (verified against v3000.11.3, read-only).
 *
 * Storage: ~/.local/share/devin/cli/sessions.db (SQLite, WAL). It is only
 * ever read through the system `sqlite3` CLI in read-only mode
 * (`-readonly` + `file:…?mode=ro`) — termbus never writes it and needs no
 * native module.
 *
 *  - sessions(id, working_directory, last_activity_at (unix s), main_chain_id, …)
 *  - message_nodes(session_id, node_id, parent_node_id, chat_message JSON, created_at)
 *
 * message_nodes is a forest: compaction re-roots copies of the prefix, and
 * a turn can leave a sibling draft next to the committed message. The live
 * conversation is the chain from `sessions.main_chain_id` (its leaf) back to
 * a root through parent_node_id.
 *
 * Which pane runs which session: session_locks/<id>.lock holds the pid of
 * the `devin acp` process serving it, a child of the TUI on the pane's tty.
 * A brand-new session may hold a lock before it has any sessions row.
 */

export function devinRoot(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_DEVIN_DIR ?? join(homedir(), '.local', 'share', 'devin', 'cli')
}

/** Session ids go into SQL text: allow only what Devin uses (word-pair ids, uuids). */
export const DEVIN_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

// ---------------------------------------------------------------------------
// Mapping chat messages → transcript events (pure)

export interface DevinParseContext {
  sessionId: string
  /** tool_call id → tool name, so results can be labeled */
  callNames: Map<string, string>
}

export function createDevinContext(sessionId: string): DevinParseContext {
  return { sessionId, callNames: new Map() }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** `thinking` is {thinking, signature, signature_type} in v3000; accept a plain string too. */
function thinkingText(t: unknown): string {
  if (typeof t === 'string') return t
  if (t && typeof t === 'object') {
    const v = (t as { thinking?: unknown; text?: unknown }).thinking ?? (t as { text?: unknown }).text
    if (typeof v === 'string') return v
  }
  return ''
}

/**
 * One message node → events. seq = node_id; subSeq orders events within the
 * node (assistant: thinking, text, then one tool_call per call). System
 * messages are injected context and user messages without
 * metadata.is_user_input are framework text — neither is emitted.
 */
export function mapDevinNode(
  row: { node_id: number; chat_message: string; created_at?: number },
  ctx: DevinParseContext,
): TranscriptEvent[] {
  let m: any
  try {
    m = JSON.parse(row.chat_message)
  } catch {
    return []
  }
  if (!m || typeof m !== 'object') return []
  const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {}
  const ts =
    typeof meta.created_at === 'string'
      ? meta.created_at
      : typeof row.created_at === 'number'
        ? new Date(row.created_at * 1000).toISOString()
        : ''
  const base = { v: 1 as const, agent: 'devin' as const, sessionId: ctx.sessionId, seq: row.node_id, subSeq: 0, epoch: 0, ts }
  const out: Array<Omit<TranscriptEvent, 'subSeq'>> = []
  const text = contentText(m.content)

  if (m.role === 'user') {
    if (meta.is_user_input === true && text) out.push({ ...base, kind: 'user_msg', text: truncate(text) })
  } else if (m.role === 'assistant') {
    const thinking = thinkingText(m.thinking)
    if (thinking) out.push({ ...base, kind: 'thinking', text: truncate(thinking, MAX_THINKING_CHARS) })
    if (text) out.push({ ...base, kind: 'assistant_msg', text: truncate(text) })
    for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const name = typeof call?.name === 'string' ? call.name : 'unknown'
      if (typeof call?.id === 'string') ctx.callNames.set(call.id, name)
      const args = call?.arguments
      const raw = typeof args === 'string' ? args : args === undefined ? '' : JSON.stringify(args)
      out.push({ ...base, kind: 'tool_call', tool: { name, ...(raw ? { inputPreview: truncate(raw, MAX_TOOL_INPUT_CHARS) } : {}) } })
    }
    // finish_reason "stop" closes the turn (tool_calls means more is coming)
    if (meta.finish_reason === 'stop') out.push({ ...base, kind: 'turn_done' })
  } else if (m.role === 'tool') {
    const name = typeof m.tool_call_id === 'string' ? ctx.callNames.get(m.tool_call_id) : undefined
    out.push({ ...base, kind: 'tool_result', ...(text ? { text: truncate(text) } : {}), ...(name ? { tool: { name } } : {}) })
  }
  // role system: injected instructions / context — skipped
  return out.map((e, i) => ({ ...e, subSeq: i }) as TranscriptEvent)
}

/** node ids from `leaf` back to its root, returned root-first. Cycle-safe. */
export function mainChain(nodes: Array<{ node_id: number; parent_node_id: number | null }>, leaf: number): number[] {
  const parent = new Map(nodes.map((n) => [n.node_id, n.parent_node_id]))
  if (!parent.has(leaf)) return []
  const chain: number[] = []
  const seen = new Set<number>()
  let cur: number | null | undefined = leaf
  while (cur !== null && cur !== undefined && parent.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = parent.get(cur)
  }
  return chain.reverse()
}

// ---------------------------------------------------------------------------
// Read-only query layer (sqlite3 CLI)

export interface DevinHead {
  leaf: number | null
  cwd: string | null
  lastActivityMs: number | null
}

export interface DevinQuery {
  head(sessionId: string): Promise<DevinHead | null>
  nodes(sessionId: string): Promise<Array<{ node_id: number; parent_node_id: number | null }>>
  messages(sessionId: string, ids: number[]): Promise<Array<{ node_id: number; chat_message: string; created_at?: number }>>
}

export async function sqliteJson(dbPath: string, sql: string): Promise<any[]> {
  const uri = `file:${encodeURI(dbPath).replace(/\?/g, '%3F').replace(/#/g, '%23')}?mode=ro`
  // -init /dev/null: never run the user's ~/.sqliterc; -batch: no interactive behaviour
  const { stdout } = await execFileP('sqlite3', ['-init', '/dev/null', '-batch', '-readonly', '-json', uri, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
  const t = stdout.trim()
  return t ? (JSON.parse(t) as any[]) : []
}

export function sqliteDevinQuery(dbPath: string, run: (db: string, sql: string) => Promise<any[]> = sqliteJson): DevinQuery {
  const sid = (id: string) => {
    if (!DEVIN_SESSION_ID.test(id)) throw new Error(`unexpected Devin session id ${JSON.stringify(id)}`)
    return `'${id}'`
  }
  return {
    async head(id) {
      const rows = await run(dbPath, `SELECT main_chain_id, working_directory, last_activity_at FROM sessions WHERE id = ${sid(id)}`)
      if (!rows.length) return null
      const r = rows[0]
      return {
        leaf: typeof r.main_chain_id === 'number' ? r.main_chain_id : null,
        cwd: typeof r.working_directory === 'string' ? r.working_directory : null,
        lastActivityMs: typeof r.last_activity_at === 'number' ? r.last_activity_at * 1000 : null,
      }
    },
    async nodes(id) {
      return run(dbPath, `SELECT node_id, parent_node_id FROM message_nodes WHERE session_id = ${sid(id)}`)
    },
    async messages(id, ids) {
      const out: Array<{ node_id: number; chat_message: string; created_at?: number }> = []
      const ints = ids.filter((n) => Number.isInteger(n))
      for (let i = 0; i < ints.length; i += 200) {
        const chunk = ints.slice(i, i + 200).join(',')
        out.push(...(await run(dbPath, `SELECT node_id, chat_message, created_at FROM message_nodes WHERE session_id = ${sid(id)} AND node_id IN (${chunk})`)))
      }
      return out
    },
  }
}

/**
 * Incremental reader for one Devin session, pollable like a SessionTailer.
 * State: `offset` = one past the last node_id emitted, so a source restored
 * after a bridge restart resumes where it stopped; `lineNo` is unused (0).
 *
 * Within a process it also remembers the chain it has emitted. The new main
 * chain must EXTEND that chain; anything else — compaction re-rooting the
 * conversation, a draft node replaced by its committed sibling, a rewind —
 * re-emits the whole new chain under a new epoch, so HQ never shows a mix of
 * two branches. (After a restart, with no chain in memory: a leaf behind the
 * cursor is a rewind; otherwise nodes past the cursor are appended.)
 */
export class DevinSessionSource {
  private offset: number
  private epoch: number
  private lastLeaf: number | null = null
  /** the chain emitted so far (root first), null until the first poll */
  private emitted: number[] | null = null
  private ctx: DevinParseContext

  constructor(
    readonly info: SessionInfo,
    private readonly opts: { initialState?: TailerState; query?: DevinQuery } = {},
  ) {
    this.offset = opts.initialState?.offset ?? 0
    this.epoch = opts.initialState?.epoch ?? 0
    this.ctx = createDevinContext(info.sessionId)
  }

  private get query(): DevinQuery {
    return this.opts.query ?? sqliteDevinQuery(this.info.path)
  }

  getState(): TailerState {
    return { offset: this.offset, epoch: this.epoch, lineNo: 0 }
  }

  private restart(): void {
    this.epoch++
    this.offset = 0
    this.ctx = createDevinContext(this.info.sessionId)
  }

  async poll(): Promise<TranscriptEvent[]> {
    const q = this.query
    const head = await q.head(this.info.sessionId)
    if (!head || head.leaf === null || head.leaf === this.lastLeaf) return []
    const chain = mainChain(await q.nodes(this.info.sessionId), head.leaf)
    if (chain.length === 0) return [] // leaf row not written yet
    let start: number // index in `chain` of the first node to emit
    if (this.emitted) {
      const prev = this.emitted
      const extends_ = prev.length <= chain.length && prev.every((id, i) => chain[i] === id)
      if (extends_) start = prev.length
      else {
        this.restart()
        start = 0
      }
    } else if (head.leaf + 1 < this.offset) {
      this.restart() // rewound while we weren't watching
      start = 0
    } else {
      start = chain.findIndex((id) => id >= this.offset)
      if (start === -1) start = chain.length
    }
    const fresh = chain.slice(start)
    const rows = fresh.length ? new Map((await q.messages(this.info.sessionId, fresh)).map((r) => [r.node_id, r])) : new Map()
    const events: TranscriptEvent[] = []
    let done = start // chain[0..done) is emitted
    for (const id of fresh) {
      const row = rows.get(id)
      if (!row) break // vanished mid-read: the rest is retried next poll
      for (const ev of mapDevinNode(row, this.ctx)) events.push({ ...ev, epoch: this.epoch })
      this.offset = Math.max(this.offset, id + 1)
      done++
    }
    this.emitted = chain.slice(0, done)
    if (done === chain.length) this.lastLeaf = head.leaf
    return events
  }
}

// ---------------------------------------------------------------------------
// Live sessions: lock files ↔ processes ↔ panes

export interface PsProc {
  pid: number
  ppid: number
  tty: string
  command: string
}

/** `ps -axo pid=,ppid=,tty=,command=` → rows. */
export function parsePsProcs(out: string): PsProc[] {
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .flatMap((m) => (m ? [{ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], command: m[4] }] : []))
}

const isDevinAcp = (command: string) => {
  const [bin = '', sub] = command.trim().split(/\s+/)
  return bin.split('/').pop() === 'devin' && sub === 'acp'
}

export async function readDevinLocks(root = devinRoot()): Promise<Array<{ sessionId: string; pid: number }>> {
  const dir = join(root, 'session_locks')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ sessionId: string; pid: number }> = []
  for (const f of files) {
    if (!f.endsWith('.lock')) continue
    const sessionId = f.slice(0, -'.lock'.length)
    if (!DEVIN_SESSION_ID.test(sessionId)) continue
    try {
      const pid = Number((await readFile(join(dir, f), 'utf8')).trim())
      if (Number.isInteger(pid) && pid > 0) out.push({ sessionId, pid })
    } catch {
      // released mid-scan
    }
  }
  return out
}

const isDevinTui = (command: string) => {
  const [bin = '', sub] = command.trim().split(/\s+/)
  return bin.split('/').pop() === 'devin' && sub !== 'acp'
}

/**
 * Live sessions: a lock whose pid is a running `devin acp` (not merely any
 * live pid — pids get reused) whose parent is a live Devin TUI (an orphaned
 * acp server has no pane). Linked to the pane by that process's tty.
 */
export function liveDevinLocks(
  locks: Array<{ sessionId: string; pid: number }>,
  procs: PsProc[],
): Array<{ sessionId: string; pid: number; tty: string | null }> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  return locks.flatMap((l) => {
    const p = byPid.get(l.pid)
    if (!p || !isDevinAcp(p.command)) return []
    const parent = byPid.get(p.ppid)
    if (!parent || !isDevinTui(parent.command)) return []
    return [{ ...l, tty: p.tty === '??' || p.tty === '-' ? null : p.tty.replace(/^\/dev\//, '') }]
  })
}

/**
 * Several locks naming the same acp process (a session switched with stale
 * locks left behind): keep, per process, the session with the latest
 * last_activity_at (unknown activity loses; ties go to the first id).
 */
export function latestPerProcess<T extends { sessionId: string; pid: number }>(
  locks: T[],
  activityMs: (sessionId: string) => number | null | undefined,
): T[] {
  const best = new Map<number, { lock: T; at: number }>()
  for (const l of [...locks].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const at = activityMs(l.sessionId) ?? -Infinity
    const cur = best.get(l.pid)
    if (!cur || at > cur.at) best.set(l.pid, { lock: l, at })
  }
  return locks.filter((l) => best.get(l.pid)?.lock === l)
}

/** The session a Devin TUI (pid) is serving: via its `devin acp` child's lock. */
export function devinSessionForTui(
  tuiPid: number,
  procs: PsProc[],
  locks: Array<{ sessionId: string; pid: number }>,
  activityMs: (sessionId: string) => number | null | undefined = () => null,
): string | null {
  const acps = new Set(procs.filter((p) => p.ppid === tuiPid && isDevinAcp(p.command)).map((p) => p.pid))
  const mine = locks.filter((l) => acps.has(l.pid))
  if (mine.length === 0) return null
  const ranked = [...mine].sort(
    (a, b) => (activityMs(b.sessionId) ?? -Infinity) - (activityMs(a.sessionId) ?? -Infinity) || a.sessionId.localeCompare(b.sessionId),
  )
  return ranked[0].sessionId
}

export async function psProcs(): Promise<PsProc[]> {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,tty=,command='], { maxBuffer: 16 * 1024 * 1024 })
  return parsePsProcs(stdout)
}

export async function discoverDevinSessions(
  opts: { root?: string; procs?: PsProc[]; query?: DevinQuery } = {},
): Promise<SessionInfo[]> {
  const root = opts.root ?? devinRoot()
  const locks = await readDevinLocks(root)
  if (locks.length === 0) return []
  let procs: PsProc[]
  try {
    procs = opts.procs ?? (await psProcs())
  } catch {
    return []
  }
  const path = join(root, 'sessions.db')
  const query = opts.query ?? sqliteDevinQuery(path)
  const live = liveDevinLocks(locks, procs)
  const heads = new Map<string, DevinHead | null>()
  for (const l of live) {
    try {
      heads.set(l.sessionId, await query.head(l.sessionId))
    } catch {
      // no sqlite3, db busy/missing: still a live session, just without cwd
      heads.set(l.sessionId, null)
    }
  }
  const out: SessionInfo[] = []
  for (const l of latestPerProcess(live, (id) => heads.get(id)?.lastActivityMs)) {
    const head = heads.get(l.sessionId) ?? null
    out.push({
      agent: 'devin',
      sessionId: l.sessionId,
      path,
      ...(head?.cwd ? { cwd: head.cwd } : {}),
      ...(l.tty ? { tty: l.tty } : {}),
      lastActivity: head?.lastActivityMs ?? Date.now(),
      sizeBytes: 0,
    })
  }
  return out
}
