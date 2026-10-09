import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // agent worktrees live under .claude/ and carry their own copy of the suite
    exclude: [...configDefaults.exclude, '.claude/**'],
    // never read the developer's own agent types / pane marks
    env: {
      TERMBUS_AGENTS_FILE: '/nonexistent/termbus-tests/agents.json',
      TERMBUS_MARKS_FILE: '/nonexistent/termbus-tests/marks.json',
      TERMBUS_CONFIG_FILE: '/nonexistent/termbus-tests/config.json',
    },
  },
})
