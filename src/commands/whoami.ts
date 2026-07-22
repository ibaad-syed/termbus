import { detectBackend } from '../backends/detect.js'
import { occupantForTty } from '../core/occupant.js'

export async function cmdWhoami(): Promise<void> {
  const backend = detectBackend()
  const panes = await backend.listPanes()
  const self = panes.find((p) => p.isSelf)
  if (!self) {
    console.log('not identifiable (ITERM_SESSION_ID unset?) — run inside an iTerm2 pane')
    return
  }
  const occ = await occupantForTty(self.tty)
  console.log(JSON.stringify({ ...self, occupant: occ.kind, backend: backend.name }, null, 2))
}
