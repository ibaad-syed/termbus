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

## Safety

- Never interrupts a busy agent (refuses; `--force` to override)
- Never targets its own pane with `send`/`ask`
- After a timeout it tells the caller to `check`, never to re-send

## Roadmap

tmux backend (SSH + iTerm tmux -CC), kitty & WezTerm backends, iTerm Python API backend (push output subscriptions), `termbus watch`.

Backends implement a 3-method interface (`listPanes/readScreen/sendText`) — contributions welcome.

## License

MIT
