import { describe, expect, it } from 'vitest'
import { isRecord } from './records.js'
import { isRow } from './rows.js'

describe('isRecord', () => {
  it.each([{}, { name: 'value' }, Object.create(null), new Date()])(
    'accepts non-array objects, not just plain JSON objects: %s',
    (value: unknown) => {
      expect(isRecord(value)).toBe(true)
    },
  )

  it.each([null, undefined, [], [{ name: 'value' }], 'text', 42, true, () => ({})])(
    'rejects arrays, null and non-objects: %s',
    (value) => {
      expect(isRecord(value)).toBe(false)
    },
  )

  it('is also the SQLite row guard', () => {
    expect(isRow).toBe(isRecord)
  })
})
