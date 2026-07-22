---
name: termbus
description: See and talk to other terminal panes in iTerm2 — other Claude/Codex sessions, shells, and dev servers. Use when the user says things like "ask the other terminal", "tell the claude in pane 2 to…", "check what the dev server says", or wants agents in different panes to collaborate.
user-invocable: true
---

# termbus — Inter-Terminal Communication

You are running inside an iTerm2 pane. Other panes (in this tab, other tabs, other windows) may contain other Claude Code sessions, Codex sessions, plain shells, or long-running processes (dev servers, logs). The `termbus` CLI lets you see them, read their screens, and send them prompts or commands.

## Commands

- `termbus list` — all panes: label (`w1.t2.p1`), occupant (claude/codex/shell/command), busy/idle, title. **Always run this first** to get exact targets.
- `termbus check <target> [--lines N]` — read a pane's current screen without touching it. Use for passive observation (build output, logs, another agent's progress).
- `termbus ask <target> "prompt"` — send a prompt/command and wait for the response. Works on shell panes (returns output + exit code) and agent panes (returns their final screen).
- `termbus ask <target> "prompt" --mailbox` — for agent panes: the agent writes its full answer to a temp file. **Prefer this for any answer longer than a few lines** — screens truncate.
- `termbus ask --batch '{"w1.t1.p2": "prompt A", "dev server": "prompt B"}'` — ask several panes in parallel; returns a JSON array.
- `termbus send <target> "text" [--no-submit]` — type into a pane without waiting for a response.
- `termbus send <target> "text" --queue` — target agent is busy? Deliver into its native input queue anyway; it sees the message mid-turn or when its current work finishes. Prints `queued to …` so you know it wasn't handled yet.
- `termbus send <target> "text" --wait [--timeout S]` — block until the pane is idle, then deliver. Also works on shell panes running a command (waits for the command to finish). Default wait budget 300s.
- `termbus send <target> --raw "2\r"` — raw input for TUIs/menus. Escapes: `\r` Enter (TUIs need `\r`, not `\n`), `\t` Tab, `\e` ESC, `\x03` Ctrl-C, `\e[A` up arrow.
- `termbus whoami` — identify your own pane.

Targets: label, session id, tty, unique title substring, all shown by `list`.

## Timeouts

`ask` defaults to 60s (`--timeout <seconds>` to change). Scale to the task:
- 60 — quick questions, status checks
- 300 — small focused task (single-file change)
- 600 — code review, multi-step task
- 1200 — debugging session, large refactor

Set your Bash tool timeout ≥ the termbus timeout. **If a timeout expires, do NOT re-send the prompt.** Run `termbus check <target>` to see progress, then wait again.

## Rules

- Never interrupt a busy agent — `ask`/`send` refuse busy panes by design. If the target is busy, prefer `--queue` (message lands in its input queue; may steer its current task) or `--wait` (delivered as a fresh turn once idle). Don't use `--force` unless the user explicitly asks you to interrupt.
- `ask --wait` and `ask --queue` work too: wait delivers the prompt once the pane is idle; queue delivers immediately and returns the agent's screen after it finally settles (pair with `--mailbox` and a generous `--timeout` since its current task runs first).
- Don't edit files another agent is actively modifying; wait for it to finish.
- Multi-line prompts to agent panes are fine — send/ask submit them in one shot. For very long instructions, write them to a file and ask the agent to read it.
- Agent `ask` without `--mailbox` returns the pane's final visible screen — fine for short answers; use `--mailbox` for anything substantial.
