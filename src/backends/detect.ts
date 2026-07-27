import { TermbusError } from '../core/errors.js'
import type { Backend } from '../core/types.js'
import { AppleScriptBackend, selfSessionIdFromEnv } from './applescript.js'

export function detectBackend(env: Record<string, string | undefined> = process.env): Backend {
  // Controlling iTerm2 does not require running inside it: launchd services,
  // agent sandboxes (which strip env vars), and other terminals all work via
  // AppleScript. On macOS, always use it; a missing/blocked iTerm2 surfaces
  // as a clear osascript error. selfSessionId is only for self-pane safety.
  if (process.platform === 'darwin') {
    return new AppleScriptBackend(selfSessionIdFromEnv(env))
  }
  throw new TermbusError(
    'unsupported platform — termbus v1 supports iTerm2 on macOS. (tmux/kitty/wezterm backends are on the roadmap; PRs welcome.)',
  )
}
