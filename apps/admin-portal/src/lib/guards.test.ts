import { describe, expect, it } from '@/test/vi'
import { isNumberMap, isNumberOrNull, isRecord, isStringArray, isStringOrNull } from '@/lib/guards'

describe('guards', () => {
  it('isRecord accepts objects and rejects null and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('isNumberOrNull and isStringOrNull accept null and one primitive each', () => {
    expect(isNumberOrNull(null)).toBe(true)
    expect(isNumberOrNull(1)).toBe(true)
    expect(isNumberOrNull('1')).toBe(false)
    expect(isStringOrNull(null)).toBe(true)
    expect(isStringOrNull('a')).toBe(true)
    expect(isStringOrNull(1)).toBe(false)
  })

  it('isStringArray requires every item to be a string', () => {
    expect(isStringArray([])).toBe(true)
    expect(isStringArray(['a', 'b'])).toBe(true)
    expect(isStringArray(['a', 1])).toBe(false)
    expect(isStringArray('a')).toBe(false)
  })

  it('isNumberMap requires every value to be a number', () => {
    expect(isNumberMap({ a: 1 })).toBe(true)
    expect(isNumberMap({ a: '1' })).toBe(false)
    expect(isNumberMap(null)).toBe(false)
  })
})
