import { describe, expect, it } from 'vitest'
import { decodeRawEscapes } from '../src/core/raw.js'

describe('decodeRawEscapes', () => {
  it('decodes newline, tab, escape, and hex bytes', () => {
    expect(decodeRawEscapes('2\\n')).toBe('2\n')
    expect(decodeRawEscapes('\\t')).toBe('\t')
    expect(decodeRawEscapes('\\e[A')).toBe('\x1b[A')
    expect(decodeRawEscapes('\\x03')).toBe('\x03')
  })
  it('leaves plain text alone', () => {
    expect(decodeRawEscapes('hello')).toBe('hello')
  })
})
