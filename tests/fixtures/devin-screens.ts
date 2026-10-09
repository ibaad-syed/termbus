/**
 * Devin CLI screens. Calibrating detection = paste a real screen here (from
 * `termbus check <label>`), add a case to tests/devin-screen.test.ts, and
 * adjust the `devin` entry's regexes in src/core/agents.ts until it passes.
 */

const RULE = '─'.repeat(100)

// VERIFIED: captured live from an iTerm2 pane (Devin CLI v3000.11.3), idle.
export const DEVIN_IDLE_REAL = `⠀⣴⣾⣶⡄⠀⠀⠀⠀
⠀⠛⠿⠟⠻⣶⣾⣶⡄  Devin CLI
⠀⣤⣶⣦⣴⠿⢿⠿⠃  v3000.11.3
⠀⠻⢿⠿⠃⠀⠀⠀⠀
 Teams · 8% remaining (resets in 2d 8h)
${RULE}
❭ Ask Devin to build features, fix bugs, or work on your code
${RULE}
SWE-2 High                                                    See all keyboard shortcuts: /shortcuts


`

// VERIFIED SHAPE (same chrome), with a finished answer above the composer and
// text the user has typed but not sent.
export const DEVIN_IDLE_AFTER_TURN = `● Yes — that's the "Model connections" feature. In the desktop app open
  Settings → Model connections and sign in.
${RULE}
❭ thanks, now open the
  settings page
${RULE}
SWE-2 High                                                    See all keyboard shortcuts: /shortcuts`

// UNVERIFIED — synthesized from UI strings in the Devin binary
// ("(esc twice to interrupt)", "Guide Devin while it works").
export const DEVIN_BUSY_SYNTH = `● Ran grep
  └ apps/server/src/services/model-connection/resolvers.ts
⠋ Thinking… (esc twice to interrupt)
${RULE}
❭ Guide Devin while it works
${RULE}
SWE-2 High                                                    See all keyboard shortcuts: /shortcuts`

// UNVERIFIED — synthesized from the binary's approval option labels and the
// docs ("Yes, always allow `<cmd>` commands in <project>").
export const DEVIN_PERMISSION_SYNTH = `● Run shell command
  rm -rf node_modules && pnpm install
› 1. Yes (Approve once)
  2. Yes, always allow \`rm\` commands in Ponder
  3. Edit command
  4. Describe change to command
  5. No`

// A screen Devin might show that matches no marker (a picker, a panel).
export const DEVIN_UNKNOWN = `Sessions in /Users/x/Ponder
  adaptive-hardcover   2 minutes ago
  different-repair     yesterday`
