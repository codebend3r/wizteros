import { afterEach, describe, expect, it } from 'vitest'
import { session } from '@/db.js'
import { asRow, asRows, fields, flag } from '@/rows.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

describe('rows', () => {
  afterEach(() => {
    removeTempDirs()
  })

  it('reads typed columns from a real row', () => {
    const path = tempDbPath()
    const row = session({
      path,
      work: (connection) =>
        asRow(connection.prepare("SELECT 'a' AS name, 1.5 AS value, NULL AS gone").get()),
    })
    expect(row).not.toBeNull()
    const read = fields(row ?? {})
    expect(read.text('name')).toBe('a')
    expect(read.number('value')).toBe(1.5)
    expect(read.textOrNull('gone')).toBeNull()
    expect(read.numberOrNull('gone')).toBeNull()
  })

  it('throws on a column of the wrong type rather than guessing', () => {
    expect(() => fields({ value: 'x' }).number('value')).toThrow(TypeError)
    expect(() => fields({ name: 1 }).text('name')).toThrow(TypeError)
  })

  it('reads a missing row as null and keeps only object rows', () => {
    expect(asRow(undefined)).toBeNull()
    expect(asRows([{ a: 1 }, null, 3])).toEqual([{ a: 1 }])
  })

  it('stores a boolean as 1 or 0, since sqlite has none to bind', () => {
    expect([flag(true), flag(false)]).toEqual([1, 0])
  })
})
