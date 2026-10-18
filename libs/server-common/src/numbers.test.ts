import { describe, expect, it } from 'vitest'
import { parseInteger } from './numbers.js'

describe('parseInteger', () => {
  it.each([
    { value: 0, expected: 0 },
    { value: -42, expected: -42 },
    { value: '42', expected: 42 },
    { value: ' \t-42\n', expected: -42 },
    { value: ' +0042 ', expected: 42 },
    { value: '-0', expected: -0 },
  ])('reads $value as $expected', ({ value, expected }) => {
    expect(parseInteger({ value })).toBe(expected)
  })

  it.each([
    null,
    undefined,
    true,
    false,
    {},
    [],
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    '  ',
    '+',
    '--1',
    '1.0',
    '1e2',
    '0x10',
    '12days',
    '1 2',
  ])('rejects a non-integer or partial parse: %s', (value) => {
    expect(parseInteger({ value })).toBeNull()
  })

  it('keeps the Plex parser stricter about a leading plus', () => {
    expect(parseInteger({ value: '+42', allowPlus: false })).toBeNull()
    expect(parseInteger({ value: ' -42 ', allowPlus: false })).toBe(-42)
    expect(parseInteger({ value: 42, allowPlus: false })).toBe(42)
  })

  it('leaves range checks to callers, preserving the existing string conversions', () => {
    expect(parseInteger({ value: '9007199254740993' })).toBe(9007199254740992)
    expect(parseInteger({ value: '9'.repeat(400) })).toBe(Number.POSITIVE_INFINITY)
  })
})
