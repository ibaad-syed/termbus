import { TermbusError } from '../core/errors.js'
import type { Backend } from '../core/types.js'
import { AppleScriptBackend, selfSessionIdFromEnv } from './applescript.js'

export function detectBackend(env: Record<string, string | undefined> = process.env): Backend {
  if (env.TERM_PROGRAM === 'iTerm.app' || env.ITERM_SESSION_ID) {
    return new AppleScriptBackend(selfSessionIdFromEnv(env))
  }
  throw new TermbusError(
    'unsupported terminal — termbus v1 supports iTerm2 on macOS. (tmux/kitty/wezterm backends are on the roadmap; PRs welcome.)',
  )
}
