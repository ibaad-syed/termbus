# X thread draft

**1/**
your claude code pane and your codex pane are strangers.

termbus makes them teammates — any iTerm2 pane can read another's screen, send it a prompt, and wait for the answer.

npm install -g termbus

[attach demo GIF]

**2/**
no daemon. no hooks. nothing spawned.

it observes the panes you already have open. close termbus → nothing dies.

that's the whole philosophy: your terminal stays yours.

**3/**
the detail i'm proudest of: it knows when an agent is *stuck*, not just busy.

"Do you want to proceed?" shows up as `input!` in termbus list. ask returns the dialog + exact keys to answer. or --on-permission approve handles it for trusted runs.

**4/**
agents know who's talking, too.

every message carries an envelope: [termbus-msg from=w1.t1.p2 kind=claude]

so your claude never mistakes a peer agent's suggestion for YOUR instruction — and knows exactly which pane to reply to.

**5/**
after install-skill you don't type any commands. just tell claude:

"ask the codex terminal to review my diff"

and it runs the whole conversation for you.

github.com/ibaad-syed/termbus — macOS + iTerm2, MIT. tmux/kitty next if people want it.
