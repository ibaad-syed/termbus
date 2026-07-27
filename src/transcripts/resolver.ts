import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import type { SessionInfo } from './types.js'

export interface DiscoverOptions {
  /** Override for ~/.claude/projects (tests inject a tmp dir). */
  claudeRoot?: string
  /** Override for ~/.codex/sessions (tests inject a tmp dir). */
  codexRoot?: string
  /** Only sessions with mtime within this window are returned. Default 48h. */
  activeWindowMs?: number
  /** Files larger than this are skipped entirely. Default 200MB. */
  maxFileBytes?: number
}

const DEFAULT_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024
/** cwd extraction starts with a small head read… */
const HEAD_BYTES = 4096
/** …but extends until the first complete line: real Codex session_meta first
 *  lines run ~18KB (they embed the agent's base instructions). */
const MAX_HEAD_BYTES = 256 * 1024

/** Read the head of a file, growing until `until(head)` is satisfied (default:
 *  contains a newline), EOF, or the cap. Claude files open with bookkeeping
 *  lines that lack cwd, so cwd extraction passes a predicate to keep growing
 *  past them. */
async function readHead(path: string, until: (head: string) => boolean = (h) => h.includes('\n')): Promise<string> {
  const fh = await open(path, 'r')
  try {
    let size = HEAD_BYTES
    for (;;) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      const head = buf.toString('utf8', 0, bytesRead)
      if (until(head) || bytesRead < size || size >= MAX_HEAD_BYTES) return head
      size = Math.min(size * 4, MAX_HEAD_BYTES)
    }
  } finally {
    await fh.close()
  }
}

/** First complete line of the head that parses as JSON and satisfies `pick`. */
function scanHeadLines<T>(head: string, pick: (obj: any) => T | undefined): T | undefined {
  const lines = head.split('\n')
  // The last segment may be a partial line cut at HEAD_BYTES — only trust it
  // if the head happened to end exactly at a newline.
  const complete = head.endsWith('\n') ? lines : lines.slice(0, -1)
  for (const line of complete) {
    if (!line.trim()) continue
    try {
      const picked = pick(JSON.parse(line))
      if (picked !== undefined) return picked
    } catch {
      /* keep scanning */
    }
  }
  return undefined
}

async function discoverClaude(root: string, opts: Required<Pick<DiscoverOptions, 'activeWindowMs' | 'maxFileBytes'>>): Promise<SessionInfo[]> {
  const out: SessionInfo[] = []
  let projects: string[]
  try {
    projects = await readdir(root)
  } catch {
    return out
  }
  const cutoff = Date.now() - opts.activeWindowMs
  for (const project of projects) {
    const dir = join(root, project)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue // not a directory, or vanished
    }
    // Only top-level session files: subagent transcripts live in a
    // `subagents/` subdirectory and are sidechains, not sessions.
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      let st
      try {
        st = await stat(path)
      } catch {
        continue
      }
      if (!st.isFile() || st.mtimeMs < cutoff || st.size > opts.maxFileBytes) continue
      let cwd: string | undefined
      try {
        const pickCwd = (obj: unknown): string | undefined => {
          const c = (obj as { cwd?: unknown })?.cwd
          return typeof c === 'string' ? c : undefined
        }
        cwd = scanHeadLines(
          await readHead(path, (h) => scanHeadLines(h, pickCwd) !== undefined),
          pickCwd,
        )
      } catch {
        /* unreadable head — session still listed, just without cwd */
      }
      out.push({
        agent: 'claude',
        sessionId: basename(file, '.jsonl'),
        path,
        ...(cwd ? { cwd } : {}),
        lastActivity: st.mtimeMs,
        sizeBytes: st.size,
      })
    }
  }
  return out
}

/** rollout-2026-07-22T11-53-47-<uuid>.jsonl → <uuid> (last 5 dash-groups). */
function codexSessionIdFromFilename(file: string): string {
  const stem = basename(file, '.jsonl').replace(/^rollout-/, '')
  // Strip the leading YYYY-MM-DDTHH-MM-SS timestamp; the rest is the uuid.
  const m = stem.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/)
  return m ? m[1] : stem
}

async function discoverCodex(root: string, opts: Required<Pick<DiscoverOptions, 'activeWindowMs' | 'maxFileBytes'>>): Promise<SessionInfo[]> {
  const out: SessionInfo[] = []
  const cutoff = Date.now() - opts.activeWindowMs
  let years: string[]
  try {
    years = await readdir(root)
  } catch {
    return out
  }
  for (const year of years) {
    let months: string[]
    try {
      months = await readdir(join(root, year))
    } catch {
      continue
    }
    for (const month of months) {
      let days: string[]
      try {
        days = await readdir(join(root, year, month))
      } catch {
        continue
      }
      for (const day of days) {
        let files: string[]
        try {
          files = await readdir(join(root, year, month, day))
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const path = join(root, year, month, day, file)
          let st
          try {
            st = await stat(path)
          } catch {
            continue
          }
          if (!st.isFile() || st.mtimeMs < cutoff || st.size > opts.maxFileBytes) continue
          let cwd: string | undefined
          let metaId: string | undefined
          try {
            const meta = scanHeadLines(await readHead(path), (obj) => {
              if (obj?.type !== 'session_meta') return undefined
              const p = obj.payload ?? {}
              return {
                cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
                id: typeof (p.session_id ?? p.id) === 'string' ? (p.session_id ?? p.id) : undefined,
              }
            })
            cwd = meta?.cwd
            metaId = meta?.id
          } catch {
            /* unreadable head — fall back to filename-derived id */
          }
          out.push({
            agent: 'codex',
            sessionId: metaId ?? codexSessionIdFromFilename(file),
            path,
            ...(cwd ? { cwd } : {}),
            lastActivity: st.mtimeMs,
            sizeBytes: st.size,
          })
        }
      }
    }
  }
  return out
}

/**
 * Scan both agents' session roots and return recently-active sessions,
 * newest first.
 */
export async function discoverSessions(opts: DiscoverOptions = {}): Promise<SessionInfo[]> {
  const claudeRoot = opts.claudeRoot ?? join(homedir(), '.claude', 'projects')
  const codexRoot = opts.codexRoot ?? join(homedir(), '.codex', 'sessions')
  const limits = {
    activeWindowMs: opts.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  }
  const [claude, codex] = await Promise.all([
    discoverClaude(claudeRoot, limits),
    discoverCodex(codexRoot, limits),
  ])
  return [...claude, ...codex].sort((a, b) => b.lastActivity - a.lastActivity)
}
