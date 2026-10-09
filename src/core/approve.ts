/**
 * Approving a dialog = choosing its affirmative option. Most agent
 * permission prompts open with "❯ 1. Yes" highlighted, so Enter is right —
 * but some don't: Claude's folder-trust dialog opens on "❯ No, exit", where
 * Enter would quit the agent. Find where the cursor is and where the
 * affirmative option is, so the caller can move there and verify before Enter.
 */

const CURSOR = /^\s*[❯›>]\s+/
const AFFIRMATIVE = /^(\d+\.\s*)?(yes\b|trust\b|allow\b|proceed\b|continue\b)/i

const optionText = (line: string) => line.replace(CURSOR, '').replace(/^\s+/, '').trim()

/** Lines of the dialog's option list, with which one has the cursor. */
export function readOptions(screen: string): { lines: string[]; cursor: number } | null {
  const tail = screen.split('\n').slice(-30)
  let ci = -1
  for (let i = tail.length - 1; i >= 0 && ci < 0; i--) if (CURSOR.test(tail[i])) ci = i
  if (ci < 0) return null
  const marker = tail[ci].search(/[❯›>]/)
  const numbered = /^\d+\./.test(optionText(tail[ci]))
  // Unselected options are aligned with the selected option's text (marker
  // column + 2). In a numbered menu only numbered lines are options (so a
  // heading like "Trust this folder?" or a footer never counts). Description
  // lines sit deeper and are skipped; a blank line ends the list.
  const isOption = (l: string) => {
    if (l.search(/\S/) !== marker + 2) return false
    return numbered ? /^\s*\d+\.\s/.test(l) : true
  }
  const isDescription = (l: string) => l.search(/\S/) > marker + 2
  let start = ci
  while (start > 0 && (isOption(tail[start - 1]) || isDescription(tail[start - 1]))) start--
  let end = ci
  while (end + 1 < tail.length && (isOption(tail[end + 1]) || isDescription(tail[end + 1]))) end++
  const lines: string[] = []
  let cursor = -1
  for (let i = start; i <= end; i++) {
    if (i === ci) {
      cursor = lines.length
      lines.push(optionText(tail[i]))
    } else if (isOption(tail[i])) lines.push(optionText(tail[i]))
  }
  return { lines, cursor }
}

/**
 * How many Down presses reach the affirmative option (0 = already there),
 * or null if there is no clearly affirmative option to choose.
 */
export function stepsToAffirmative(screen: string): number | null {
  const o = readOptions(screen)
  if (!o) return null
  if (AFFIRMATIVE.test(o.lines[o.cursor])) return 0
  const target = o.lines.findIndex((l) => AFFIRMATIVE.test(l))
  if (target < 0) return null
  return target - o.cursor
}

export function cursorOnAffirmative(screen: string): boolean {
  const o = readOptions(screen)
  return !!o && AFFIRMATIVE.test(o.lines[o.cursor])
}
