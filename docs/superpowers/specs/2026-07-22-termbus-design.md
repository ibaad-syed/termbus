# termbus — Design

**Date:** 2026-07-22
**Status:** Approved by Ibrahim (2026-07-22)
**Repo:** github.com/ibaad-syed/termbus (personal OSS, MIT). Not part of Ponder.

## What it is

A CLI + agent skill that lets AI agents (Claude Code, Codex) and humans in different terminal panes/tabs/windows see each other, read each other's screens, and exchange prompts/commands — like Maestri's `maestri list/ask/check`, but for the terminal you already use. Core idea: **every terminal on the screen can see all the others, and any agent can `ask` any of them.**

## How Maestri does it (verified)

Maestri's skill instructs the agent to call a `maestri` CLI; the Maestri app owns the PTYs and brokers everything. termbus replicates the broker with the terminal emulator's own automation surface instead of owning PTYs.

## Spike findings (2026-07-22, iTerm2 3.6.6, macOS)

All proven via AppleScript with zero setup, from inside a live Claude Code session:

1. **Enumeration** — `tell application "iTerm2"` iterates windows → tabs → sessions; each session exposes `id` (UUID), `tty` (`/dev/ttysNNN`), `name` (title). Works across windows.
2. **Occupant detection** — `ps -t <tty> -o pid,stat,command`; the `+` in STAT marks the foreground process group. A Claude pane shows `claude --resume …`, idle shell shows `-zsh`. This labels panes claude/codex/shell/other.
3. **Screen read** — `contents of session` returns the visible screen text.
4. **Injection + read-back** — `tell s to write text "…"` executed a command in a neighbor pane; reading `contents` back captured its output. Full round-trip verified.
5. **Self-identification** — `$ITERM_SESSION_ID` (e.g. `w0t0p0:UUID`) matches the session `id`, so the CLI knows which pane is "self".
6. iTerm2 **Python API is NOT required** for v1: it was disabled on the dev machine and enabling requires an iTerm restart. It becomes an optional richer backend later (push output subscriptions, full scrollback, session variables).

## Architecture

```
termbus CLI (TypeScript, Node ≥ 20, npm package `termbus`, bin `termbus`)
 ├── core: verbs list / check / send / ask, pane addressing, occupant detection
 ├── backends (plugin interface, one selected per host terminal)
 │    ├── applescript  (v1, macOS + iTerm2, zero setup — shells out to osascript)
 │    └── (later) iterm-api, tmux, kitty, wezterm
 └── skills/claude/termbus/SKILL.md  (bundled Claude Code skill; installable via `termbus install-skill`)
```

No daemon in v1. Every CLI invocation is stateless: enumerate → act → exit. (A daemon/watch mode is a later feature, not v1.)

### Backend interface

```ts
interface Backend {
  listPanes(): Promise<Pane[]>            // all windows/tabs/panes
  readScreen(id: PaneId, opts?): Promise<string>
  sendText(id: PaneId, text: string, submit: boolean): Promise<void>
}
// Pane: { id, label, title, tty, isSelf, windowIndex, tabIndex, paneIndex }
```

Everything else (occupant detection, ask protocol, addressing) lives in core and is backend-agnostic. `ps`-based occupant detection is core, keyed by the backend-provided tty.

### CLI surface (v1)

- `termbus list [--json]` — table of panes: label, name/title, occupant (`claude|codex|shell|cmd:<name>`), busy/idle, self-marker.
- `termbus check <target> [--lines N]` — print target pane's screen.
- `termbus send <target> <text> [--no-submit] [--raw]` — type into a pane. `--raw` supports escapes (`\n`, `\e`, `\x03`, arrow keys) for TUIs/menus.
- `termbus ask <target> <prompt> [--timeout S] [--mailbox]` — send and wait for completion, print the response. Exit non-zero on timeout with the partial screen shown.
- `termbus ask --batch '<json map>'` — parallel asks, JSON array result (Maestri parity).
- `termbus whoami` — self pane info.
- `termbus install-skill` — copy the bundled skill into `~/.claude/skills/termbus/`.

### Addressing

Targets resolve in order: exact session UUID → stable auto-label (`w1.t2.p1`) → pane title/name (case-insensitive substring, error if ambiguous) → tty. `list` always shows all four so agents can copy an unambiguous one.

### The ask protocol (per occupant type)

- **shell** — wrap: `<cmd>; printf '\n__termbus_done_<nonce>_%s__\n' $?`. Poll screen until the nonce sentinel appears; return output between injection point and sentinel, plus exit code. Deterministic; no heuristics.
- **claude / codex (agent panes)** — send the prompt text + Enter. Poll screen (default 1s interval) with a per-agent idle detector:
  - busy = agent-specific working indicators (e.g. Claude Code's spinner/`esc to interrupt` footer; Codex equivalent) present;
  - idle = input-prompt chrome visible and screen stable (unchanged across 2 consecutive polls).
  Detectors are data-driven (regex sets per agent type in one module) so new agents/TUI versions are a small patch, and each detector carries fixture screen-captures as test data.
- **`--mailbox` mode (agents, for long/reliable answers)** — prompt is wrapped with: "When finished, write your complete answer to `<tmpdir>/termbus/<nonce>.md`". Completion = file exists; response = file contents. Sidesteps screen truncation; recommended in the skill for anything longer than a few lines.
- **Timeout discipline** (mirrors Maestri): default 60s; skill teaches scaling (5–20 min for delegated tasks) and *never re-send on timeout* — `check` the pane instead.

### Safety rules (enforced in core)

- `send`/`ask` to a **busy** agent pane → refuse with the busy screen shown (`--force` to override). Never interrupt a working agent.
- Never target **self** with `send`/`ask` (would deadlock a blocking wait).
- Sentinel/mailbox nonces are `crypto.randomUUID()` — no collisions with screen content.

### Claude Code skill (bundled)

Mirrors the Maestri skill's shape: teaches `list` first, target naming, timeout scaling, mailbox mode for long answers, don't-interrupt-busy rule, and `check` for passive observation. Written so Codex can consume the same doc (AGENTS.md snippet included).

## Error handling

- iTerm not running / not iTerm host → clear error naming supported terminals.
- macOS automation permission missing → osascript error is detected and mapped to a "System Settings → Privacy → Automation" instruction.
- Ambiguous target → list matching panes, exit 2.
- Pane disappears mid-ask → error with last captured screen.

## Testing strategy

- **Unit:** target resolution, occupant classification (`ps` output fixtures), idle detectors (screen-text fixtures for Claude/Codex busy/idle states), sentinel parsing.
- **Integration (macOS + iTerm2 only, opt-in `TERMBUS_E2E=1`):** script creates a scratch iTerm window, runs `list/check/send/ask` against a real zsh pane with sentinels, closes it. This re-runs the spike as a regression test.
- CI: unit tests on Linux/macOS; e2e manual/local only (needs a GUI iTerm).

## Non-goals (v1)

Windows/Linux terminals, tmux/kitty/wezterm backends (interface reserved), daemon/push notifications, notes/canvas features, cross-machine messaging, iTerm Python API backend.

## Later roadmap

tmux backend (also unlocks SSH + iTerm tmux -CC), iTerm Python API backend (push subscriptions, full scrollback), kitty/wezterm, `termbus watch` (subscribe to a pane), upstream iTerm PR only if a primitive gap is found.
