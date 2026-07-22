export function wrapShellCommand(cmd: string, nonce: string): string {
  return `${cmd}; printf '\\n__termbus_${nonce}_%s__\\n' $?`
}

export function extractShellOutput(
  screen: string,
  nonce: string,
): { output: string; exitCode: number } | null {
  const lines = screen.split('\n')
  const sentinelRe = new RegExp(`^__termbus_${nonce}_(\\d+)__$`)
  let sentinelIdx = -1
  let exitCode = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(sentinelRe)
    if (m) {
      sentinelIdx = i
      exitCode = Number(m[1])
      break
    }
  }
  if (sentinelIdx === -1) return null

  // The echoed command line contains both "printf" and the nonce.
  let cmdIdx = -1
  for (let i = sentinelIdx - 1; i >= 0; i--) {
    if (lines[i].includes(nonce) && lines[i].includes('printf')) {
      cmdIdx = i
      break
    }
  }
  const output = lines.slice(cmdIdx + 1, sentinelIdx).join('\n').trimEnd()
  return { output, exitCode }
}
