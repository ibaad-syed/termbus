// Verbatim screen captures (iTerm2 `contents`, 80 columns) of question dialogs,
// taken live from Claude Code 2.1.288 and codex-cli 0.160.1. Trailing spaces
// are part of the capture.

const RULE = '─'.repeat(80)

const CLAUDE_PROMPT_ECHO = [
  '❯ Test harness: immediately call the AskUserQuestion tool with exactly two      ',
  '  questions. Q1 header "Color", question "Pick a color?", single select,        ',
  '  options Red, Green, Blue (each with a short description). Q2 header           ',
  '  "Toppings", question "Pick toppings?", multiSelect true, options Cheese,      ',
  '  Olives, Basil. After I answer, just repeat my answers verbatim.               ',
]

/** Two questions (single + multi), fresh. */
export const CLAUDE_TWO_FRESH = [
  ...CLAUDE_PROMPT_ECHO,
  RULE,
  '←  ☐ Color  ☐ Toppings  ✔ Submit  → ',
  ' ',
  'Pick a color? ',
  ' ',
  '❯ 1. Red ',
  '     A warm, vibrant hue ',
  '  2. Green ',
  '     A cool, natural color ',
  '  3. Blue ',
  '     A calm, peaceful tone ',
  '  4. Type something. ',
  RULE,
  '  5. Chat about this ',
  ' ',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n')

/** Same dialog after "2" on Q1: now on the multi-select tab. */
export const CLAUDE_TWO_ON_Q2 = [
  ...CLAUDE_PROMPT_ECHO,
  RULE,
  '←  ☒ Color  ☐ Toppings  ✔ Submit  → ',
  ' ',
  'Pick toppings? ',
  ' ',
  '❯ 1. [ ] Cheese ',
  '         Melted and creamy ',
  '  2. [ ] Olives ',
  '         Tangy and briny ',
  '  3. [ ] Basil ',
  '         Fresh and aromatic ',
  '  4. [ ] Type something ',
  '     Submit ',
  RULE,
  '  5. Chat about this ',
  ' ',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n')

export function claudeQ2With(ticked: { cheese?: boolean; olives?: boolean; basil?: boolean }): string {
  const box = (b?: boolean) => (b ? '[✔]' : '[ ]')
  return CLAUDE_TWO_ON_Q2.replace('[ ] Cheese', `${box(ticked.cheese)} Cheese`)
    .replace('[ ] Olives', `${box(ticked.olives)} Olives`)
    .replace('[ ] Basil', `${box(ticked.basil)} Basil`)
    .replace('☐ Toppings', ticked.cheese || ticked.olives || ticked.basil ? '☒ Toppings' : '☐ Toppings')
}

export function claudeTwoReview(toppings: string): string {
  return [
    ...CLAUDE_PROMPT_ECHO,
    ' ',
    RULE,
    '←  ☒ Color  ☒ Toppings  ✔ Submit  → ',
    ' ',
    'Review your answers ',
    '  ',
    ' ● Pick a color? ',
    '   → Green ',
    ' ● Pick toppings? ',
    `   → ${toppings} `,
    '          ',
    'Ready to submit your answers? ',
    '      ',
    '❯ 1. Submit answers ',
    '  2. Cancel ', // the review tab has no key-hint footer (live capture)
  ].join('\n')
}

/** After submit: the dialog is gone, Claude is answering. */
export const CLAUDE_TWO_DONE = [
  ...CLAUDE_PROMPT_ECHO,
  ' ',
  '⏺ User answered Claude\'s questions: ',
  '  ⎿  · Pick a color? → Green ',
  '     · Pick toppings? → Cheese, Basil ',
  ' ',
  RULE,
  '❯  ',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts · ← for agents',
].join('\n')

/** One single-select question: no tab arrows, no review tab. */
export const CLAUDE_SINGLE_FRESH = [
  '  answer.                                                                       ',
  RULE,
  ' ☐ Fruit  ',
  ' ',
  'Which fruit? ',
  ' ',
  '❯ 1. Apple ',
  '  2. Pear ',
  '  3. Plum ',
  '  4. Type something. ',
  RULE,
  '  5. Chat about this ',
  ' ',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

export const CLAUDE_SINGLE_OTHER_FOCUSED = CLAUDE_SINGLE_FRESH.replace('❯ 1. Apple', '  1. Apple')
  .replace('  4. Type something.', '❯ 4. Type something.')
  .replace('Enter to select · ↑/↓ to navigate · Esc to cancel', 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel')

export const CLAUDE_SINGLE_OTHER_TYPED = CLAUDE_SINGLE_OTHER_FOCUSED.replace('❯ 4. Type something.', '❯ 4. Mango, ripe')

const CODEX_PROMPT_ECHO = [
  '› Again: call request_user_input immediately with three questions. Q1 id "pet", ',
  '  header "Pet", question "Which pet?", options Cat, Dog, Fish. Q2 id "city", ',
  '  header "City", question "Which city?", options Paris, Tokyo. Q3 id "size", ',
  '  header "Size", question "Which size?", options Small, Large. Then repeat my ',
  '  answers verbatim and stop. ',
  '  ',
  '  ',
  '  ',
]

export const CODEX_THREE_FRESH = [
  ...CODEX_PROMPT_ECHO,
  '  Question 1/3 (3 unanswered) ',
  '  Which pet? ',
  '  ',
  '  › 1. Cat                Choose cat.                                          ',
  '    2. Dog                Choose dog. ',
  '    3. Fish               Choose fish. ',
  '    4. None of the above  Optionally, add details in notes (tab) ',
  '  ',
  '  tab to add notes | enter to submit answer | ←/→ to navigate questions ',
  '  esc to interrupt',
].join('\n')

export const CODEX_THREE_Q2 = [
  ...CODEX_PROMPT_ECHO,
  '  Question 2/3 (2 unanswered) ',
  '  Which city? ',
  '  ',
  '  › 1. Paris              Choose Paris.                                        ',
  '    2. Tokyo              Choose Tokyo. ',
  '    3. None of the above  Optionally, add details in notes (tab) ',
  '  ',
  '  tab to add notes | enter to submit answer | ←/→ to navigate questions ',
  '  esc to interrupt',
].join('\n')

export const CODEX_THREE_Q3 = [
  ...CODEX_PROMPT_ECHO,
  '  Question 3/3 (1 unanswered) ',
  '  Which size? ',
  '  ',
  '  › 1. Small              Choose small.                                        ',
  '    2. Large              Choose large. ',
  '    3. None of the above  Optionally, add details in notes (tab) ',
  '  ',
  '  tab to add notes | enter to submit all | ←/→ to navigate questions ',
  '  esc to interrupt',
].join('\n')

export const CODEX_DONE = [
  '• Questions 3/3 answered ',
  '  • Which pet? ',
  '    answer: Dog ',
  '  ',
  '• Working (5s • esc to interrupt) ',
  '  ',
  '  ',
  '› Ask Codex to do anything ',
  '  ',
  '  GPT-6-Astra medium · /tmp/qa Plan mode ',
  '  ? for shortcuts                                     ⚠ 3 warnings · f2 to view',
].join('\n')

/** A ~40-column split pane: question, descriptions and footer all wrap.
 *  The last six lines are verbatim from a live capture in a split pane. */
export const CLAUDE_NARROW_FRESH = [
  '──────────────────────────────────────',
  '←  ☐ Color  ☐ Toppings  ✔ Submit  → ',
  ' ',
  'Pick a color for the new dashboard ',
  'theme, keeping accessibility in mind? ',
  ' ',
  '❯ 1. Red ',
  '     A warm color that draws attention ',
  '     to alerts and errors ',
  '  2. Green ',
  '     The color green ',
  '  3. Blue ',
  '     The color blue ',
  '  4. Type something. ',
  '──────────────────────────────────────',
  '  5. Chat about this ',
  ' ',
  'Enter to select · Tab/Arrow keys to  ',
  'navigate · Esc to cancel',
].join('\n')

/** Q2 with focus moved to "None of the above" (Up wraps to the last row). */
export const CODEX_THREE_Q2_OTHER_FOCUSED = CODEX_THREE_Q2.replace('  › 1. Paris', '    1. Paris').replace(
  '    3. None of the above',
  '  › 3. None of the above',
)

/** Notes field open — layout per codex-rs request_user_input snapshot
 *  `options_notes_visible`: an "› Add notes" input and the footer switches to
 *  "tab or esc to clear notes" (only shown while notes are visible). */
export function codexQ2NotesOpen(typed = ''): string {
  return [
    ...CODEX_PROMPT_ECHO,
    '  Question 2/3 (2 unanswered) ',
    '  Which city? ',
    '  ',
    '    1. Paris              Choose Paris. ',
    '    2. Tokyo              Choose Tokyo. ',
    '  › 3. None of the above  Optionally, add details in notes (tab) ',
    '  ',
    `  › ${typed || 'Add notes'} `,
    '  ',
    '  tab or esc to clear notes | enter to submit answer ',
  ].join('\n')
}

/** A TodoWrite list (☐/☒ lines under ⎿) above an ordinary Claude picker that
 *  happens to use the same "Enter to select · ↑/↓ to navigate" footer —
 *  must NOT read as an AskUserQuestion dialog. */
export const CLAUDE_TODOS_ABOVE_PICKER = [
  '⏺ Update Todos ',
  '  ⎿  ☒ Read the bridge code ',
  '     ☐ Add the parser ',
  '     ☐ Write tests ',
  ' ',
  RULE,
  ' Select model ',
  ' ',
  '❯ 1. Default (recommended) ',
  '  2. Opus ',
  '  3. Haiku ',
  ' ',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')
