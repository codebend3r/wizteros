import { describe, expect, it } from '@/test/vi'
import { isRecord, isStringArray } from '@/lib/guards'

describe('guards', () => {
  it('isRecord accepts objects and rejects null and primitives', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('isStringArray requires every item to be a string', () => {
    expect(isStringArray([])).toBe(true)
    expect(isStringArray(['a', 'b'])).toBe(true)
    expect(isStringArray(['a', 1])).toBe(false)
    expect(isStringArray('a')).toBe(false)
  })
})
