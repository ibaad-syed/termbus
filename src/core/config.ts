import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ~/.termbus/config.json — the bridge's relay settings and this Mac's local consents. */
export interface BridgeConfig {
  relay?: string
  secret?: string
  /** this Mac's local consent to run commands the user approves in HQ (also gates remote marks) */
  allowExec?: boolean
  /** this Mac's local consent for HQ's "Full auto" commands (implies allowExec) */
  allowAutoExec?: boolean
}

export function configFile(env: Record<string, string | undefined> = process.env): string {
  return env.TERMBUS_CONFIG_FILE ?? join(homedir(), '.termbus', 'config.json')
}

export function readConfig(path = configFile()): BridgeConfig {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig
  } catch {
    return {}
  }
}
