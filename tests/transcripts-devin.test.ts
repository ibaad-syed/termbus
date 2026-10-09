import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkSessionsByTty, TranscriptFeeder } from '../src/commands/bridge-transcripts.js'
import {
  createDevinContext,
  DevinSessionSource,
  devinSessionForTui,
  discoverDevinSessions,
  liveDevinLocks,
  mainChain,
  mapDevinNode,
  parsePsProcs,
  sqliteDevinQuery,
  type DevinQuery,
} from '../src/transcripts/devin.js'
import type { SessionInfo } from '../src/transcripts/types.js'

// Shapes as stored by Devin CLI v3000.11.3 (contents shortened).
const msg = (o: Record<string, unknown>) => JSON.stringify(o)
const SYSTEM = msg({ message_id: 's', role: 'system', content: 'You are Devin…', metadata: {} })
const INJECTED = msg({ message_id: 'i', role: 'user', content: '<environment>…</environment>', metadata: { is_user_input: null } })
const USER = msg({
  message_id: 'u',
  role: 'user',
  content: 'can I connect my claude codex subscription\n',
  metadata: { is_user_input: true, created_at: '2026-10-07T15:45:08.163894Z' },
})
const ASSISTANT_TOOL = msg({
  message_id: 'a1',
  role: 'assistant',
  content: '',
  thinking: { thinking: 'Look for the feature flag.', signature: 'sig', signature_type: 'anthropic' },
  tool_calls: [{ id: 'call_1', name: 'exec', arguments: { command: 'grep -rn modelConnectionDisabled apps' }, index: 0, kind: 'function' }],
  metadata: { finish_reason: 'tool_calls', created_at: '2026-10-07T15:46:31.089229Z' },
})
const TOOL = msg({
  message_id: 't1',
  role: 'tool',
  content: 'Output from command in shell cf78c8:\napps/server/src/resolvers.ts',
  tool_call_id: 'call_1',
  metadata: { created_at: '2026-10-07T15:46:31.548534Z' },
})
const ASSISTANT_FINAL = msg({
  message_id: 'a2',
  role: 'assistant',
  content: 'Yes — that\'s the "Model connections" feature.',
  thinking: { thinking: 'Answer.', signature: 'sig', signature_type: 'anthropic' },
  tool_calls: [],
  metadata: { finish_reason: 'stop', created_at: '2026-10-07T15:46:44.826862Z' },
})

describe('mapDevinNode', () => {
  it('maps user input, thinking, text, tool calls and results; skips system and injected text', () => {
    const ctx = createDevinContext('different-repair')
    expect(mapDevinNode({ node_id: 0, chat_message: SYSTEM }, ctx)).toEqual([])
    expect(mapDevinNode({ node_id: 1, chat_message: INJECTED }, ctx)).toEqual([])
    expect(mapDevinNode({ node_id: 3, chat_message: USER }, ctx)).toEqual([
      {
        v: 1,
        agent: 'devin',
        sessionId: 'different-repair',
        seq: 3,
        subSeq: 0,
        epoch: 0,
        ts: '2026-10-07T15:45:08.163894Z',
        kind: 'user_msg',
        text: 'can I connect my claude codex subscription\n',
      },
    ])
    const a = mapDevinNode({ node_id: 31, chat_message: ASSISTANT_TOOL }, ctx)
    expect(a.map((e) => [e.kind, e.seq, e.subSeq])).toEqual([
      ['thinking', 31, 0],
      ['tool_call', 31, 1],
    ])
    expect(a[0].text).toBe('Look for the feature flag.')
    expect(a[1].tool).toEqual({ name: 'exec', inputPreview: '{"command":"grep -rn modelConnectionDisabled apps"}' })
    const t = mapDevinNode({ node_id: 32, chat_message: TOOL }, ctx)
    expect(t).toMatchObject([{ kind: 'tool_result', seq: 32, tool: { name: 'exec' }, text: expect.stringContaining('resolvers.ts') }])
    const f = mapDevinNode({ node_id: 67, chat_message: ASSISTANT_FINAL }, ctx)
    expect(f.map((e) => e.kind)).toEqual(['thinking', 'assistant_msg', 'turn_done'])
  })
  it('falls back to the row timestamp, tolerates string thinking and junk', () => {
    const ctx = createDevinContext('s')
    const e = mapDevinNode({ node_id: 5, created_at: 1791388004, chat_message: msg({ role: 'assistant', content: 'hi', thinking: 'plain' }) }, ctx)
    expect(e.map((x) => x.kind)).toEqual(['thinking', 'assistant_msg'])
    expect(e[0].ts).toBe(new Date(1791388004 * 1000).toISOString())
    expect(mapDevinNode({ node_id: 6, chat_message: '{not json' }, ctx)).toEqual([])
  })
})

describe('mainChain', () => {
  // real shape: compaction re-roots copies, turns leave sibling drafts
  const nodes = [
    { node_id: 0, parent_node_id: null },
    { node_id: 3, parent_node_id: 0 },
    { node_id: 21, parent_node_id: null },
    { node_id: 28, parent_node_id: 21 },
    { node_id: 30, parent_node_id: 28 }, // draft
    { node_id: 31, parent_node_id: 28 }, // committed
    { node_id: 32, parent_node_id: 31 },
  ]
  it('walks from the leaf to its root, root first', () => {
    expect(mainChain(nodes, 32)).toEqual([21, 28, 31, 32])
    expect(mainChain(nodes, 99)).toEqual([])
  })
  it('survives a cycle', () => {
    expect(mainChain([{ node_id: 1, parent_node_id: 2 }, { node_id: 2, parent_node_id: 1 }], 1)).toEqual([2, 1])
  })
})

function memoryQuery(): DevinQuery & { rows: Map<number, { parent: number | null; msg: string }>; leaf: number | null } {
  const q = {
    rows: new Map<number, { parent: number | null; msg: string }>(),
    leaf: null as number | null,
    async head() {
      return q.leaf === null && q.rows.size === 0 ? null : { leaf: q.leaf, cwd: '/w', lastActivityMs: 1 }
    },
    async nodes() {
      return [...q.rows].map(([node_id, r]) => ({ node_id, parent_node_id: r.parent }))
    },
    async messages(_: string, ids: number[]) {
      return ids.filter((i) => q.rows.has(i)).map((node_id) => ({ node_id, chat_message: q.rows.get(node_id)!.msg }))
    },
  }
  return q
}

const INFO: SessionInfo = { agent: 'devin', sessionId: 'adaptive-hardcover', path: '/x/sessions.db', lastActivity: 0, sizeBytes: 0 }

describe('DevinSessionSource', () => {
  it('a fresh session (no row yet) yields nothing; then events stream incrementally', async () => {
    const q = memoryQuery()
    const src = new DevinSessionSource(INFO, { query: q })
    expect(await src.poll()).toEqual([])
    q.rows.set(0, { parent: null, msg: SYSTEM })
    q.rows.set(1, { parent: 0, msg: USER })
    q.leaf = 1
    expect((await src.poll()).map((e) => [e.kind, e.seq])).toEqual([['user_msg', 1]])
    expect(await src.poll()).toEqual([]) // leaf unchanged
    q.rows.set(2, { parent: 1, msg: ASSISTANT_TOOL })
    q.rows.set(3, { parent: 1, msg: ASSISTANT_TOOL }) // committed sibling of the draft
    q.rows.set(4, { parent: 3, msg: TOOL })
    q.leaf = 4
    const ev = await src.poll()
    expect(ev.map((e) => [e.kind, e.seq])).toEqual([
      ['thinking', 3],
      ['tool_call', 3],
      ['tool_result', 4],
    ])
    expect(ev[2].tool?.name).toBe('exec')
    expect(src.getState()).toEqual({ offset: 5, epoch: 0, lineNo: 0 })
  })
  it('resumes from persisted state without re-emitting', async () => {
    const q = memoryQuery()
    q.rows.set(0, { parent: null, msg: USER })
    q.rows.set(1, { parent: 0, msg: ASSISTANT_FINAL })
    q.leaf = 1
    const src = new DevinSessionSource(INFO, { query: q, initialState: { offset: 1, epoch: 0, lineNo: 0 } })
    expect((await src.poll()).map((e) => e.seq)).toEqual([1, 1, 1])
  })
  it('a rewind (leaf behind the cursor) re-emits the chain under a new epoch', async () => {
    const q = memoryQuery()
    q.rows.set(0, { parent: null, msg: USER })
    q.rows.set(1, { parent: 0, msg: ASSISTANT_FINAL })
    q.rows.set(2, { parent: 1, msg: USER })
    q.leaf = 2
    const src = new DevinSessionSource(INFO, { query: q })
    await src.poll()
    q.leaf = 0
    const ev = await src.poll()
    expect(ev.map((e) => [e.kind, e.seq, e.epoch])).toEqual([['user_msg', 0, 1]])
    expect(src.getState()).toEqual({ offset: 1, epoch: 1, lineNo: 0 })
  })
  it('a row missing mid-read stops there and is retried', async () => {
    const q = memoryQuery()
    q.rows.set(0, { parent: null, msg: USER })
    q.rows.set(1, { parent: 0, msg: ASSISTANT_FINAL })
    q.leaf = 1
    const realMessages = q.messages
    q.messages = async (s, ids) => (await realMessages(s, ids)).filter((r) => r.node_id !== 1)
    const src = new DevinSessionSource(INFO, { query: q })
    expect((await src.poll()).map((e) => e.seq)).toEqual([0])
    q.messages = realMessages
    expect((await src.poll()).map((e) => e.kind)).toEqual(['thinking', 'assistant_msg', 'turn_done'])
  })
})

describe('locks ↔ processes ↔ panes', () => {
  // live pane: -zsh → devin (TUI) → devin acp; 4783 is a stale lock
  const procs = parsePsProcs(` 11400 11399 ttys006  -zsh
 11405 11400 ttys006  devin
 42698 11405 ttys006  /Users/u/.local/bin/devin acp
  4783     1 ??       /usr/sbin/some-other-daemon`)
  const locks = [
    { sessionId: 'adaptive-hardcover', pid: 42698 },
    { sessionId: 'different-repair', pid: 4783 }, // pid reused by an unrelated process
    { sessionId: 'gone-session', pid: 5 },
  ]
  it('only locks held by a running `devin acp` are live, with that process\'s tty', () => {
    expect(liveDevinLocks(locks, procs)).toEqual([{ sessionId: 'adaptive-hardcover', pid: 42698, tty: 'ttys006' }])
  })
  it('the TUI pid finds its session through its acp child', () => {
    expect(devinSessionForTui(11405, procs, locks)).toBe('adaptive-hardcover')
    expect(devinSessionForTui(11400, procs, locks)).toBeNull()
  })
  it('sessions link to the pane on the same tty — never by cwd', () => {
    const links = linkSessionsByTty(
      [{ sessionId: 'adaptive-hardcover', tty: 'ttys006' }, { sessionId: 'x' }],
      [
        { paneId: 'A', tty: '/dev/ttys005' },
        { paneId: 'B', tty: '/dev/ttys006' },
      ],
    )
    expect([...links]).toEqual([['adaptive-hardcover', 'B']])
  })
  it('the feeder links a Devin session to its pane by tty', async () => {
    const f = new TranscriptFeeder(async () => new Response('{}'))
    const session = { ...INFO, tty: 'ttys006', cwd: '/elsewhere' }
    await f.refreshLinks([{ id: 'B', label: 'w1.t1.p2', title: 'devin', tty: '/dev/ttys006', isSelf: false, windowIndex: 1, tabIndex: 1, paneIndex: 2 }], [session])
    expect(f.linkedPane('adaptive-hardcover')).toBe('B')
  })
})

let sqliteAvailable = true
try {
  execFileSync('sqlite3', ['-version'])
} catch {
  sqliteAvailable = false
}

describe.skipIf(!sqliteAvailable)('against a real SQLite file (sqlite3 CLI, read-only)', () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'termbus-devin-'))
    mkdirSync(join(root, 'session_locks'))
    writeFileSync(join(root, 'session_locks', 'adaptive-hardcover.lock'), '42698')
    writeFileSync(join(root, 'session_locks', 'bad id;drop.lock'), '1')
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const sql = [
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0);`,
      `CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));`,
      `INSERT INTO sessions VALUES ('adaptive-hardcover', '/Users/u/My Project', 'local', 'swe-2', 'normal', 1791387908, 1791388004, NULL, 3, 0);`,
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES`,
      `('adaptive-hardcover', 0, NULL, ${q(SYSTEM)}, 1791388004),`,
      `('adaptive-hardcover', 1, 0, ${q(USER)}, 1791388004),`,
      `('adaptive-hardcover', 2, 1, ${q(ASSISTANT_TOOL)}, 1791388004),`,
      `('adaptive-hardcover', 3, 2, ${q(TOOL)}, 1791388004),`,
      `('other-session', 0, NULL, ${q(USER)}, 1791388004);`,
    ].join('\n')
    execFileSync('sqlite3', [join(root, 'sessions.db')], { input: sql })
    return root
  }

  it('discovers the live session and streams its main chain', async () => {
    const root = makeRoot()
    const procs = parsePsProcs(' 11405 11400 ttys006 devin\n 42698 11405 ttys006 /Users/u/.local/bin/devin acp')
    const [info, ...rest] = await discoverDevinSessions({ root, procs })
    expect(rest).toEqual([])
    expect(info).toMatchObject({
      agent: 'devin',
      sessionId: 'adaptive-hardcover',
      cwd: '/Users/u/My Project',
      tty: 'ttys006',
      lastActivity: 1791388004 * 1000,
      path: join(root, 'sessions.db'),
    })
    const src = new DevinSessionSource(info)
    const ev = await src.poll()
    expect(ev.map((e) => [e.kind, e.seq, e.subSeq])).toEqual([
      ['user_msg', 1, 0],
      ['thinking', 2, 0],
      ['tool_call', 2, 1],
      ['tool_result', 3, 0],
    ])
    expect(await src.poll()).toEqual([])
  })
  it('refuses session ids that are not plain words', async () => {
    const q = sqliteDevinQuery(join(makeRoot(), 'sessions.db'))
    await expect(q.head("x' OR 1=1 --")).rejects.toThrow(/unexpected Devin session id/)
    expect(await q.head('nope')).toBeNull()
  })
})
