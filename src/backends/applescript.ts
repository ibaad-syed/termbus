import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TermbusError } from '../core/errors.js'
import type { Backend, CreatePaneOptions, Pane } from '../core/types.js'

const execFileP = promisify(execFile)

const FS = String.fromCharCode(31) // unit separator between fields
const RS = String.fromCharCode(30) // record separator between panes

const LIST_SCRIPT = `
on run argv
  set fieldSep to character id 31
  set recSep to character id 30
  set out to ""
  tell application "iTerm2"
    set wIdx to 0
    repeat with w in windows
      set wIdx to wIdx + 1
      set tIdx to 0
      repeat with t in tabs of w
        set tIdx to tIdx + 1
        set pIdx to 0
        repeat with s in sessions of t
          set pIdx to pIdx + 1
          set out to out & wIdx & fieldSep & tIdx & fieldSep & pIdx & fieldSep & (id of s) & fieldSep & (tty of s) & fieldSep & (name of s) & recSep
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`

// Same as LIST_SCRIPT, but never launches iTerm2: \`tell application\` would
// start it, so check first. Background snapshots must not reopen a terminal
// the user just quit.
const LIST_IF_RUNNING_SCRIPT = LIST_SCRIPT.replace(
  'on run argv\n',
  'on run argv\n  if application "iTerm2" is not running then return "NOT_RUNNING"\n',
)

const READ_SCRIPT = `
on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is target then return contents of s
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found: " & target
end run
`

const SEND_SCRIPT = `
on run argv
  set target to item 1 of argv
  set payload to item 2 of argv
  set doSubmit to item 3 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is target then
            if doSubmit is "1" then
              -- Two separate writes: agent TUIs (claude/codex) treat a chunk that
              -- arrives with its trailing CR as a paste, so the CR becomes a line
              -- break in the composer instead of Enter. A standalone CR after a
              -- short delay registers as a real keypress.
              tell s to write text payload newline NO
              delay 0.2
              tell s to write text ""
            else
              tell s to write text payload newline NO
            end if
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found: " & target
end run
`

const RENAME_SCRIPT = `
on run argv
  set target to item 1 of argv
  set newName to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is target then
            tell s to set name to newName
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found: " & target
end run
`

// Layout creation. argv: command ("" = profile default), profile ("" =
// default profile; an unknown name falls back to default), then the target.
// With a command, the pane runs it instead of the profile's shell, so nothing
// has to be typed into a pane whose readiness is unknown.
const CREATE_WINDOW_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  set prof to item 2 of argv
  tell application "iTerm2"
    set w to missing value
    if prof is not "" then
      try
        if cmd is "" then
          set w to (create window with profile prof)
        else
          set w to (create window with profile prof command cmd)
        end if
      end try
    end if
    if w is missing value then
      if cmd is "" then
        set w to (create window with default profile)
      else
        set w to (create window with default profile command cmd)
      end if
    end if
    return id of current session of w
  end tell
end run
`

const CREATE_TAB_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  set prof to item 2 of argv
  set target to item 3 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is target then
            set nt to missing value
            if prof is not "" then
              try
                if cmd is "" then
                  tell w to set nt to (create tab with profile prof)
                else
                  tell w to set nt to (create tab with profile prof command cmd)
                end if
              end try
            end if
            if nt is missing value then
              if cmd is "" then
                tell w to set nt to (create tab with default profile)
              else
                tell w to set nt to (create tab with default profile command cmd)
              end if
            end if
            return id of current session of nt
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found: " & target
end run
`

const SPLIT_SCRIPT = `
on run argv
  set cmd to item 1 of argv
  set prof to item 2 of argv
  set target to item 3 of argv
  set stacked to (item 4 of argv) is "h"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is target then
            set ns to missing value
            if prof is not "" then
              try
                if stacked then
                  if cmd is "" then
                    tell s to set ns to (split horizontally with profile prof)
                  else
                    tell s to set ns to (split horizontally with profile prof command cmd)
                  end if
                else
                  if cmd is "" then
                    tell s to set ns to (split vertically with profile prof)
                  else
                    tell s to set ns to (split vertically with profile prof command cmd)
                  end if
                end if
              end try
            end if
            if ns is missing value then
              if stacked then
                if cmd is "" then
                  tell s to set ns to (split horizontally with default profile)
                else
                  tell s to set ns to (split horizontally with default profile command cmd)
                end if
              else
                if cmd is "" then
                  tell s to set ns to (split vertically with default profile)
                else
                  tell s to set ns to (split vertically with default profile command cmd)
                end if
              end if
            end if
            return id of ns
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "session not found: " & target
end run
`

// Sizes, profiles and window shapes for layout capture. Never launches iTerm2.
const GEOMETRY_SCRIPT = `
on run argv
  if application "iTerm2" is not running then return "NOT_RUNNING"
  set fieldSep to character id 31
  set recSep to character id 30
  set out to ""
  tell application "iTerm2"
    repeat with w in windows
      set b to bounds of w
      set ww to (item 3 of b) - (item 1 of b)
      set wh to (item 4 of b) - (item 2 of b)
      repeat with t in tabs of w
        repeat with s in sessions of t
          set out to out & (id of s) & fieldSep & (columns of s) & fieldSep & (rows of s) & fieldSep & ww & fieldSep & wh & fieldSep & (profile name of s) & recSep
        end repeat
      end repeat
    end repeat
  end tell
  return out
end run
`

export interface PaneGeometry {
  cols: number
  rows: number
  windowPx: { w: number; h: number }
  profile: string
}

export function parseGeometryOutput(raw: string): Map<string, PaneGeometry> {
  const out = new Map<string, PaneGeometry>()
  for (const rec of raw.split(RS)) {
    const f = rec.split(FS)
    if (f.length < 6) continue
    out.set(f[0], {
      cols: Number(f[1]),
      rows: Number(f[2]),
      windowPx: { w: Number(f[3]), h: Number(f[4]) },
      profile: f.slice(5).join(FS),
    })
  }
  return out
}

async function osascript(script: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('osascript', ['-e', script, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout.replace(/\n$/, '')
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : ''
    const detail = stderr.trim() || (err instanceof Error ? err.message : String(err))
    if (stderr.includes('-1728') || /can.t get application|application .*(isn.t|not) running|-600/i.test(stderr)) {
      throw new TermbusError(
        'iTerm2 is not available. termbus needs iTerm2 installed (and running) on macOS — install from https://iterm2.com, then retry.',
      )
    }
    if (stderr.includes('-1743') || /not allowed|authoriz/i.test(stderr)) {
      throw new TermbusError(
        'macOS blocked automation of iTerm2. Fix: System Settings → Privacy & Security → Automation → allow your terminal to control iTerm2, then retry.',
      )
    }
    if (stderr.includes('session not found')) {
      throw new TermbusError('pane disappeared (session not found) — run `termbus list` again', 2)
    }
    throw new TermbusError(`osascript failed: ${detail}`)
  }
}

export function selfSessionIdFromEnv(env: Record<string, string | undefined>): string | null {
  const raw = env.ITERM_SESSION_ID // e.g. "w0t0p0:DAEADA41-…"
  if (!raw) return null
  const idx = raw.indexOf(':')
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

export function parseListOutput(raw: string, selfSessionId: string | null): Pane[] {
  return raw
    .split(RS)
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => rec.split(FS))
    .filter((parts) => parts.length >= 6)
    .map((parts) => {
      const [w, t, p, id, tty] = parts
      const title = parts.slice(5).join(FS)
      return {
        id,
        title,
        tty,
        windowIndex: Number(w),
        tabIndex: Number(t),
        paneIndex: Number(p),
        label: `w${w}.t${t}.p${p}`,
        isSelf: selfSessionId !== null && id === selfSessionId,
      }
    })
}

export class AppleScriptBackend implements Backend {
  readonly name = 'applescript'
  constructor(private readonly selfSessionId: string | null) {}

  async listPanes(): Promise<Pane[]> {
    const raw = await osascript(LIST_SCRIPT, [])
    return parseListOutput(raw, this.selfSessionId)
  }

  async listPanesIfRunning(): Promise<Pane[] | null> {
    const raw = await osascript(LIST_IF_RUNNING_SCRIPT, [])
    return raw === 'NOT_RUNNING' ? null : parseListOutput(raw, this.selfSessionId)
  }

  async readScreen(paneId: string): Promise<string> {
    return osascript(READ_SCRIPT, [paneId])
  }

  async sendText(paneId: string, text: string, submit: boolean): Promise<void> {
    await osascript(SEND_SCRIPT, [paneId, text, submit ? '1' : '0'])
  }

  async setPaneName(paneId: string, name: string): Promise<void> {
    await osascript(RENAME_SCRIPT, [paneId, name.slice(0, 120)])
  }

  async createWindow(opts: CreatePaneOptions = {}): Promise<string> {
    return osascript(CREATE_WINDOW_SCRIPT, [opts.command ?? '', opts.profile ?? ''])
  }

  async createTab(nearPaneId: string, opts: CreatePaneOptions = {}): Promise<string> {
    return osascript(CREATE_TAB_SCRIPT, [opts.command ?? '', opts.profile ?? '', nearPaneId])
  }

  async splitPane(paneId: string, opts: CreatePaneOptions & { stacked?: boolean } = {}): Promise<string> {
    return osascript(SPLIT_SCRIPT, [opts.command ?? '', opts.profile ?? '', paneId, opts.stacked ? 'h' : 'v'])
  }

  async paneGeometry(): Promise<Map<string, PaneGeometry> | null> {
    const raw = await osascript(GEOMETRY_SCRIPT, [])
    return raw === 'NOT_RUNNING' ? null : parseGeometryOutput(raw)
  }
}
