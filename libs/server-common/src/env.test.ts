import { describe, expect, it } from 'vitest'
import { parseEmailAllowlist, parseList, requireEnv, trimTrailingSlashes } from './env.js'

describe('requireEnv', () => {
  it('passes when every name is present', () => {
    expect(() => requireEnv({ names: ['A', 'B'], env: { A: 'a', B: 'b' } })).not.toThrow()
  })

  it('names every missing variable at once', () => {
    expect(() => requireEnv({ names: ['A', 'B', 'C'], env: { B: 'b' } })).toThrow(
      'missing required environment: A, C',
    )
  })

  it('treats set-but-empty as present', () => {
    expect(() => requireEnv({ names: ['A'], env: { A: '' } })).not.toThrow()
  })
})

describe('parseList', () => {
  it('trims entries and drops the blank ones', () => {
    expect(parseList(' a , ,b,, c ')).toEqual(['a', 'b', 'c'])
  })

  it('reads unset as empty', () => {
    expect(parseList(undefined)).toEqual([])
  })
})

describe('parseEmailAllowlist', () => {
  it('lowercases every entry', () => {
    expect([...parseEmailAllowlist(' Admin@Example.com ,other@example.com')]).toEqual([
      'admin@example.com',
      'other@example.com',
    ])
  })

  it('is empty when only separators are set', () => {
    expect(parseEmailAllowlist('  ,  ').size).toBe(0)
  })
})

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash, like str.rstrip("/")', () => {
    expect(trimTrailingSlashes('https://example.com//')).toBe('https://example.com')
  })

  it('leaves a bare url alone and reads unset as empty', () => {
    expect(trimTrailingSlashes('https://example.com')).toBe('https://example.com')
    expect(trimTrailingSlashes(undefined)).toBe('')
  })
})
