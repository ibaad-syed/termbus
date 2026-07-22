import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installSkill, packageRoot } from '../src/commands/install-skill.js'

describe('packageRoot', () => {
  it('finds the directory containing package.json', () => {
    const root = packageRoot()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('termbus')
  })
})

describe('installSkill', () => {
  it('copies the bundled skill into the target directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'termbus-test-'))
    const dest = installSkill(home)
    expect(dest).toBe(join(home, '.claude', 'skills', 'termbus'))
    const skill = readFileSync(join(dest, 'SKILL.md'), 'utf8')
    expect(skill).toContain('name: termbus')
  })
})
