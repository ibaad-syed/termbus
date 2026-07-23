# r/ClaudeAI draft

**Title:**
I made my Claude Code and Codex terminals talk to each other (iTerm2, no daemon)

**Body:**

Like a lot of you I usually have 2–4 agent panes open — Claude Code on the feature, Codex reviewing, a dev server, sometimes another Claude on a different repo. And I was the messenger between all of them: copy, cmd+], paste, wait, copy back.

So I built **termbus**: a tiny CLI that lets panes see and talk to each other.

```
npm install -g termbus
termbus install-skill
```

After `install-skill`, you can literally tell Claude *"ask the codex terminal to review this diff"* and it does the whole thing — finds the pane, checks it isn't busy, sends the prompt with a sender tag, waits for the answer.

Things it handles that surprised me:

- **Permission prompts.** `termbus list` shows a third state — `input!` — when an agent is stuck at "Do you want to proceed?". You get told exactly how to answer it remotely, or `--on-permission approve` auto-confirms for trusted tasks.
- **Busy agents.** Messages refuse by default; `--queue` drops into Claude's native "type while it's working" queue (it sees it mid-turn), `--wait` delivers when it goes idle.
- **Who's talking.** Messages arrive tagged `[termbus-msg from=w1.t1.p2 kind=claude …]` so your Claude knows it's a peer agent, not you — and replies to the right pane instead of treating a bot suggestion as your instruction.
- **`termbus watch --notify`** in a spare pane = macOS notification the moment any agent needs you.

No daemon, no hooks, no config, nothing spawned — it observes the panes you already have open via AppleScript, and if you close it nothing dies.

macOS + iTerm2 only right now. tmux/kitty/wezterm backends are on the roadmap (it's a 3-method interface, contributions welcome).

GitHub: https://github.com/ibaad-syed/termbus

Would love to hear how you're juggling multiple agent terminals — that workflow research is what shapes the roadmap.
