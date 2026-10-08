import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // agent worktrees live under .claude/ and carry their own copy of the suite
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
