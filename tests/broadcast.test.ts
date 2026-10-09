import { describe, expect, it } from 'vitest'
import { groupPrefix } from '../src/commands/broadcast.js'

describe('groupPrefix (recipients see the message went to a group)', () => {
  it('department, all, plain list, single', () => {
    expect(groupPrefix('@api', 3)).toBe('(to @api) ')
    expect(groupPrefix('@ALL', 5)).toBe('(to all agents) ')
    expect(groupPrefix(null, 3)).toBe('(to 3 agents) ')
    expect(groupPrefix(null, 1)).toBe('')
  })
})
