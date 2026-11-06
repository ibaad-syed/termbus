import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * iTerm2's AppleScript can read a tab's own name (the `tab.titleOverride`
 * variable) but cannot set it; only the Python API can. termbus keeps the
 * `iterm2` package in a venv of its own, made on first use, so nothing is
 * installed into the user's Python.
 */
export function pythonEnvDir(home: string = homedir()): string {
  return join(home, '.termbus', 'iterm2-python')
}

const SET_TITLES_PY = `
import json, sys, iterm2
async def main(conn):
    app = await iterm2.async_get_app(conn)
    failed = []
    for item in json.loads(sys.argv[1]):
        s = app.get_session_by_id(item["paneId"])
        if s is None or s.tab is None:
            failed.append(item["paneId"])
            continue
        await s.tab.async_set_title(item["title"])
    print(json.dumps(failed))
iterm2.run_until_complete(main)
`

async function ensurePython(dir: string): Promise<string> {
  const py = join(dir, 'bin', 'python3')
  const ready = async () => {
    try {
      await execFileP(py, ['-c', 'import iterm2'], { timeout: 20_000 })
      return true
    } catch {
      return false
    }
  }
  if (existsSync(py) && (await ready())) return py
  await execFileP('python3', ['-m', 'venv', dir], { timeout: 60_000 })
  await execFileP(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'iterm2'], { timeout: 180_000 })
  if (!(await ready())) throw new Error('the iterm2 Python package did not install')
  return py
}

/** Name the tab of each pane. Returns the panes it could not name (all of them when the API is unavailable). */
export async function setTabTitlesViaPython(titles: Array<{ paneId: string; title: string }>): Promise<string[]> {
  if (titles.length === 0) return []
  try {
    const py = await ensurePython(pythonEnvDir())
    // a cookie lets a script started outside iTerm2 use the API without a confirmation prompt
    const { stdout: ck } = await execFileP('osascript', ['-e', 'tell application "iTerm2" to request cookie and key for app named "termbus"'], {
      timeout: 20_000,
    })
    const [cookie, key] = ck.trim().split(' ')
    const { stdout } = await execFileP(py, ['-c', SET_TITLES_PY, JSON.stringify(titles)], {
      timeout: 30_000,
      env: { ...process.env, ITERM2_COOKIE: cookie, ITERM2_KEY: key },
    })
    const failed = JSON.parse(stdout.trim().split('\n').pop() ?? '[]') as string[]
    return Array.isArray(failed) ? failed : titles.map((t) => t.paneId)
  } catch {
    return titles.map((t) => t.paneId)
  }
}
