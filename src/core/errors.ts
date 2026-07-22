import type { Pane } from './types.js'

export class TermbusError extends Error {
  constructor(message: string, public readonly exitCode: number = 1) {
    super(message)
    this.name = new.target.name
  }
}

export class TargetNotFoundError extends TermbusError {
  constructor(target: string) {
    super(`no pane matches target "${target}" — run \`termbus list\` to see targets`, 2)
  }
}

export class AmbiguousTargetError extends TermbusError {
  constructor(target: string, matches: Pane[]) {
    const list = matches.map((p) => `  ${p.label}  ${p.title}`).join('\n')
    super(`target "${target}" is ambiguous, matches:\n${list}\nuse the label or session id instead`, 2)
  }
}

export class BusyPaneError extends TermbusError {
  constructor(pane: Pane, public readonly screen: string) {
    super(`pane ${pane.label} (${pane.title}) is busy — not interrupting. Use \`termbus check ${pane.label}\` to watch it, or --force to override`, 4)
  }
}

export class AskTimeoutError extends TermbusError {
  constructor(pane: Pane, public readonly screen: string) {
    super(`timed out waiting for ${pane.label} — do NOT re-send; run \`termbus check ${pane.label}\` and wait longer`, 3)
  }
}
