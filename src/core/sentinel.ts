const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Both markers are emitted by printf with a leading \n, so each lands at
 * column 0 on its own screen line regardless of how the echoed command
 * wrapped. Output is everything between them — the echo is never consulted.
 */
export function wrapShellCommand(cmd: string, nonce: string): string {
  return `printf '\\n__termbus_${nonce}_begin__\\n'; ${cmd}; printf '\\n__termbus_${nonce}_%s__\\n' $?`
}

export function extractShellOutput(
  screen: string,
  nonce: string,
): { output: string; exitCode: number } | null {
  const lines = screen.split('\n')
  const esc = escapeRegExp(nonce)
  const endRe = new RegExp(`^__termbus_${esc}_(\\d+)__$`)
  const beginLine = `__termbus_${nonce}_begin__`

  let endIdx = -1
  let exitCode = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(endRe)
    if (m) {
      endIdx = i
      exitCode = Number(m[1])
      break
    }
  }
  if (endIdx === -1) return null

  let beginIdx = -1
  for (let i = endIdx - 1; i >= 0; i--) {
    if (lines[i].trim() === beginLine) {
      beginIdx = i
      break
    }
  }
  // beginIdx === -1: begin marker scrolled off the visible screen (long
  // output) — return what's visible from the top.
  const output = lines.slice(beginIdx + 1, endIdx).join('\n').trimEnd()
  return { output, exitCode }
}
