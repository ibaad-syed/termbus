#!/usr/bin/env node
import { TermbusError } from './core/errors.js'

const HELP = `termbus — talk between terminal panes (iTerm2)

Usage:
  termbus list [--json]                    panes: label, occupant, busy state
  termbus check <target> [--lines N]       read a pane's screen
  termbus send <target> <text> [--raw] [--no-submit] [--queue] [--wait] [--timeout S] [--force] [--plain]
  termbus ask <target> <prompt> [--timeout S] [--mailbox] [--queue] [--wait] [--force] [--plain]
  termbus ask --batch '{"target":"prompt",...}' [--timeout S] [--mailbox]
  termbus watch [target ...] [--interval S] [--notify] [--push <target>]
  termbus whoami                           this pane's identity
  termbus install-skill                    install the Claude Code skill

Busy panes: the default refuses busy agent panes. Pick one of:
  --queue  deliver now into a busy agent's native input queue (it sees it mid-turn)
  --wait   poll until the pane is idle, then deliver (also waits out shell commands)
  --force  interrupt regardless

Permission prompts: agents stopped at a dialog show STATE "input!" in list.
ask surfaces them (exit 5) with instructions; --on-permission approve|return|fail
sets the policy (approve presses Enter for you — opt-in, use with care).
watch alerts when a pane needs attention (--notify macOS banner, --push <pane>
queues a heads-up message to a supervisor pane).

Targets: session id, label (w1.t2.p1), tty (ttys009), title substring, or "self".
Never re-send after a timeout — use \`termbus check\` and keep waiting.`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'list':
      return (await import('./commands/list.js')).cmdList(rest)
    case 'check':
      return (await import('./commands/check.js')).cmdCheck(rest)
    case 'send':
      return (await import('./commands/send.js')).cmdSend(rest)
    case 'watch':
      return (await import('./commands/watch.js')).cmdWatch(rest)
    case 'ask':
      return (await import('./commands/ask.js')).cmdAsk(rest)
    case 'whoami':
      return (await import('./commands/whoami.js')).cmdWhoami()
    case 'install-skill':
      return (await import('./commands/install-skill.js')).cmdInstallSkill()
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      return
    default:
      console.error(`termbus: unknown command "${cmd}"\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  if (err instanceof TermbusError) {
    console.error(`termbus: ${err.message}`)
    process.exit(err.exitCode)
  }
  throw err
})
