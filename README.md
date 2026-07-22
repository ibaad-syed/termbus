# termbus

Let AI agents — and you — talk between terminal panes.

Every pane in your iTerm2 (other Claude Code sessions, Codex sessions, shells, dev servers) becomes visible and addressable. Any agent can list the others, read their screens, run commands in shell panes, and delegate prompts to other agents — inspired by Maestri's canvas, built for the terminal you already use.

```sh
npm install -g termbus   # or: pnpm add -g termbus
termbus install-skill    # teach Claude Code how to use it

termbus list
# LABEL      OCCUPANT  STATE  TTY        TITLE
# w1.t1.p1   claude    idle   ttys008    reviewer  (self)
# w1.t1.p2   claude    busy   ttys009    worker
# w1.t2.p1   shell     -      ttys011    dev server

termbus ask "worker" "run the test suite and summarize failures" --timeout 600 --mailbox
termbus ask "dev server" "tail -5 server.log"
termbus check "worker"        # peek at a pane without touching it
```

## How it works

No daemon, no fork of your terminal. termbus drives iTerm2's AppleScript automation to enumerate panes, read screens, and type into sessions; `ps` on each pane's tty identifies the occupant (claude / codex / shell). Shell asks are wrapped in printf sentinels carrying the exit code; agent asks poll for the TUI to go idle, or use `--mailbox` to have the agent write its full answer to a file.

## Requirements

- macOS + iTerm2 (grant your terminal Automation permission for iTerm2 on first use)
- Node ≥ 20

## Busy panes

Sending to a busy pane refuses by default. Opt into one of:

- `--queue` — deliver into a busy agent's native input queue (Claude Code and Codex both accept messages typed mid-turn); termbus reports `queued to …` so the sender knows it isn't handled yet
- `--wait [--timeout S]` — poll until the pane goes idle, then deliver; also waits out a foreground command in a shell pane
- `--force` — interrupt regardless

## Permission prompts

Agents block on modal dialogs (tool permissions, trust prompts). termbus detects these: `list` shows the pane as `input!`, and `ask` returns early (exit 5) with the dialog on screen and the exact keys to answer it (`send <target> --raw '\r'` approve / `--raw '\e'` reject). `ask --on-permission approve` auto-confirms dialogs for trusted unattended tasks (capped, opt-in). `termbus watch` is a long-running monitor for this: run it in its own pane and it reports state transitions, fires a macOS notification (`--notify`), or queues a heads-up to a supervisor pane (`--push <pane>`) whenever a watched agent stops at a prompt.

## Safety

- Never interrupts a busy agent (refuses; `--queue`/`--wait` to defer, `--force` to override)
- Never targets its own pane with `send`/`ask`
- After a timeout it tells the caller to `check`, never to re-send

## Roadmap

tmux backend (SSH + iTerm tmux -CC), kitty & WezTerm backends, iTerm Python API backend (push output subscriptions), hook-based event feed (Claude Code `Notification` hook / Codex `notify` instead of screen polling), subscribe/unsubscribe pub-sub routing on top of `watch`.

Backends implement a 3-method interface (`listPanes/readScreen/sendText`) — contributions welcome.

## License

MIT
