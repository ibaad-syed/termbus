# Show HN draft

**Title:**
Show HN: Termbus – AI agents in your iTerm2 panes can see and talk to each other

**URL:** https://github.com/ibaad-syed/termbus

**First comment (post immediately after submitting):**

I kept running Claude Code in one iTerm2 pane and Codex in another, and they had no idea the other existed. If I wanted one to review the other's work, I was the messenger — copy, switch pane, paste, wait, copy back.

termbus is a small daemonless CLI that fixes that. Any pane can list the others, read their screens, and send them prompts. An agent can `termbus ask "the codex pane" "review my diff"` and get the answer back. There's a bundled skill so Claude Code picks this up automatically.

The parts that took actual design work:

- Delivering a prompt to an agent TUI reliably: iTerm's `write text` sends the text and trailing Enter in one write, which Claude/Codex treat as a paste — the Enter becomes a newline in the composer instead of a submit. termbus writes the payload, waits 200ms, then sends a bare CR so it registers as a real keypress.
- Busy state is screen-truth, not hooks: a footer-scoped regex table per agent. A third state — awaiting-input — catches permission prompts ("Do you want to proceed?") so a stuck agent isn't mistaken for an idle one. `ask` returns early with the dialog and exit code 5; `--on-permission approve` can auto-confirm (opt-in, capped).
- Sending to a busy agent refuses by default. `--queue` uses the TUI's native type-while-busy queue; `--wait` polls until idle. Remote approvals (a separate experiment) verify a fingerprint of the prompt before sending a single key, so an Enter meant for prompt A can never land on prompt B.
- Messages carry a sender envelope (`[termbus-msg v=1 from=w1.t1.p2 kind=claude id=…]`) so the receiving agent knows this is a peer, not its human, and knows where to reply.

Deliberate non-goals, after looking hard at the graveyard of agent orchestrators: no daemon, no kanban, no spawning/owning sessions — it only observes panes you already have open.

macOS + iTerm2 only for now (AppleScript backend); tmux/kitty/wezterm are a 3-method backend interface away, PRs welcome.

`npm install -g termbus`

Happy to answer anything about the terminal-scraping tradeoffs vs hook-based approaches.
