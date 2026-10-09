# termbus

**Your iTerm2 panes can see and talk to each other.**

You've got Claude Code in one pane, Codex in another, a dev server in a third. Today they're strangers. termbus makes them a team: any pane can read another's screen, send it a prompt, wait for its answer — and knows when an agent is busy or stuck at a permission prompt.

![termbus demo](docs/demo.gif)

```sh
npm install -g termbus
termbus install-skill   # teaches Claude Code to use it
termbus update          # later: get the latest version
```

No hooks. No config. It observes the sessions you already have open — if you close termbus, nothing dies. And if your Mac restarts, `termbus restore` brings every agent back, mid-conversation.

## What you can do

```sh
termbus list                              # every pane: claude/codex/shell, idle/busy/input!
termbus ask "worker" "run the tests and summarize failures" --timeout 300
termbus send w1.t2.p1 "also add edge-case tests" --queue    # busy agent? lands in its input queue
termbus check "dev server"                # read any pane's screen without touching it
termbus watch --notify                    # macOS alert when any agent needs you
termbus restore                           # after a restart: reopen every agent, same conversations
```

Or don't type any of this — after `install-skill`, just tell your Claude:
*"ask the codex terminal to review my diff"* and it handles the rest.

## Why it's different

- **Attaches to your existing panes.** Other tools spawn and own their sessions; termbus observes the terminal you already work in. Close it, nothing dies.
- **Knows when an agent is stuck.** Permission prompts (`Do you want to proceed?`) are detected as a third state — `input!` — not mistaken for idle. `ask` returns early with the dialog and the exact keys to answer it, or auto-approves with `--on-permission approve` (opt-in, capped).
- **Never interrupts by default.** Busy agents refuse messages unless you choose: `--queue` (their native input queue — they see it mid-turn), `--wait` (deliver when idle), or `--force`.
- **Agents know who's talking.** Messages carry a sender envelope (`[termbus-msg v=1 from=w1.t1.p2 kind=claude …]`) so a receiving agent can reply to the right pane — and never mistakes a peer for its human.
- **Works across models.** Claude Code, Codex, plain shells, dev servers — one interface. New agent TUIs are a few regexes to add.

## Survive a restart

Restart your Mac (or quit iTerm2) and your agents normally vanish — you're left re-opening panes and hunting for `--resume` IDs. termbus remembers them instead:

```sh
termbus restore --dry-run   # preview what comes back
termbus restore             # reopen it
```

- **Every agent resumes its own conversation** — Claude Code and Codex, in the directory it ran in, with its permission flags (`--dangerously-skip-permissions`, `--yolo`, model…) when they can be read unambiguously.
- **Your layout comes back** — windows, tabs, and each tab's split arrangement (side by side, stacked, nested). Shells and dev-server panes reopen as shells in their directory; their commands are not re-run.
- **Nothing is duplicated** — agents still running anywhere are skipped, so running `restore` twice is harmless.
- **It's automatic.** The first time you run termbus, it starts remembering in the background (a small launchd service; turn off with `termbus snapshot --uninstall`). After a restart you get a notification telling you how many agents can come back. `termbus restore --list` shows saved snapshots; `--generation N` restores an older one.

Under the hood: Claude Code's session is read from its per-process session file, Codex's from the session log it holds open; pane sizes reveal each tab's split tree. Nothing is ever typed into a pane — each restored pane launches its own resume command.

## How it works

AppleScript automation reads pane screens and types into sessions; `ps` on each pane's tty identifies the occupant. Shell commands are wrapped in sentinels that carry the exit code; agent prompts poll the TUI's busy/idle/prompt chrome. Long answers use `--mailbox`: the agent writes its full reply to a file instead of the screen.

## Requirements

- macOS + iTerm2 (grant Automation permission on first use)
- Node ≥ 20

## Busy panes

Sending to a busy pane refuses by default. Opt into one of:

- `--queue` — deliver into a busy agent's native input queue; termbus reports `queued` so the sender knows it isn't handled yet
- `--wait [--timeout S]` — poll until the pane goes idle, then deliver; also waits out a foreground command in a shell pane
- `--force` — interrupt regardless

## Permission prompts

Agents block on modal dialogs (tool permissions, trust prompts). termbus sees them: `list` shows `input!`, `ask` exits with code 5 plus the dialog and how to answer it (`send <target> --raw '\r'` approve / `--raw '\e'` reject). `ask --on-permission approve` auto-confirms for trusted unattended tasks. `termbus watch` runs in its own pane and fires a macOS notification (`--notify`) or queues a heads-up to a supervisor pane (`--push`) when anything needs attention.

## Remote control — see and approve your agents from your phone

termbus pairs with a companion web app, **termbus HQ**: every agent session becomes a chat thread you can read from anywhere, message into, and — when an agent stops at a permission prompt — approve or reject with a tap. Approvals are verified against the live screen before a single key is sent, so a tap meant for one prompt can never land on another. You get a push notification the moment an agent needs you.

```sh
termbus bridge --relay https://<your-hq> --secret <token> --install
```

That installs a launchd service (runs at login, restarts automatically) streaming your panes to HQ over HTTPS — outbound only, nothing listens on your Mac. Sign in, generate the connect command, paste it once. Each person self-hosts their own HQ and sees only their own terminals.

> HQ is a self-hosted Next.js + Postgres app (Vercel + Neon free tiers). It's in early access — [open an issue](https://github.com/ibaad-syed/termbus/issues) if you'd like access or the deploy guide.

## Safety

- Never interrupts a busy agent (refuses; `--queue`/`--wait` to defer, `--force` to override)
- Never targets its own pane, never auto-answers a dialog unless you opted in
- After a timeout it tells the caller to `check`, never to re-send
- Remote approvals are per-prompt fingerprint-verified; the bridge connects outbound only and holds no inbound port
- Restore never guesses: an agent whose conversation can't be identified is skipped, never resumed into the wrong one; prompts are never replayed; the background snapshotter never launches iTerm2

## Roadmap

tmux / kitty / WezTerm backends · hook-based event feed · message ledger with groups & broadcast. Roadmap is pulled by users — [open an issue](https://github.com/ibaad-syed/termbus/issues) with what you'd use.

Backends implement a 3-method interface (`listPanes/readScreen/sendText`) — contributions welcome.

## License

MIT
