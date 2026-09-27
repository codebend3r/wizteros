import { describe, expect, it } from 'vitest'
import { pyIsoformat } from '@/admin/pyIsoformat.js'

// Every expectation below is what CPython 3.12.13 printed for
// `datetime.fromisoformat(text.replace("Z", "+00:00")).isoformat()`, with
// null where it raised ValueError. The replace is reset_expiry's own, so it is
// applied here the same way before the helper sees the text.

const CASES: readonly (readonly [string, string | null])[] = [
  // what the portal actually sends: Date#toISOString()
  ['2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00+00:00'],
  ['2026-08-01T00:01:00Z', '2026-08-01T00:01:00+00:00'],
  // date only, both forms, stays naive
  ['2026-08-01', '2026-08-01T00:00:00'],
  ['20260801', '2026-08-01T00:00:00'],
  ['2024-02-29', '2024-02-29T00:00:00'],
  ['0001-01-01T00:00:00', '0001-01-01T00:00:00'],
  // the separator is any one character
  ['2026-08-01 00:01:02', '2026-08-01T00:01:02'],
  ['2026-08-01x00:01', '2026-08-01T00:01:00'],
  // seconds and minutes may be left off, and the basic form is fine
  ['2026-08-01T00:01', '2026-08-01T00:01:00'],
  ['2026-08-01T00', '2026-08-01T00:00:00'],
  ['2026-08-01T0001', '2026-08-01T00:01:00'],
  ['20260801T000102', '2026-08-01T00:01:02'],
  // a fraction is cut to microseconds and printed as six digits only when nonzero
  ['2026-08-01T00:01:02.5', '2026-08-01T00:01:02.500000'],
  ['2026-08-01T00:01:02,5', '2026-08-01T00:01:02.500000'],
  ['2026-08-01T00:01:02.123456789', '2026-08-01T00:01:02.123456'],
  ['2026-08-01T00:01:02.000001', '2026-08-01T00:01:02.000001'],
  ['2026-08-01T00:01:02.0000009', '2026-08-01T00:01:02'],
  ['2026-08-01T00:01:02.000000', '2026-08-01T00:01:02'],
  // an offset is kept as given, never converted to UTC
  ['2026-08-01T00:01:02+05:30', '2026-08-01T00:01:02+05:30'],
  ['2026-08-01T00:01:02-0530', '2026-08-01T00:01:02-05:30'],
  ['2026-08-01T12+01', '2026-08-01T12:00:00+01:00'],
  ['2026-08-01T00:01:02+05:30:15', '2026-08-01T00:01:02+05:30:15'],
  ['2026-08-01T00:01:02-05:30:15.5', '2026-08-01T00:01:02-05:30:15.500000'],
  ['2026-08-01T00:01:02+05:30:00', '2026-08-01T00:01:02+05:30'],
  ['2026-08-01T00:01:02+23:59:59.999999', '2026-08-01T00:01:02+23:59:59.999999'],
  // offset fields are not range-checked, only the total
  ['2026-08-01T00:01:02+05:75', '2026-08-01T00:01:02+06:15'],
  // a zero offset is UTC, whatever its sign or its microseconds
  ['2026-08-01T00:01:02-00:00', '2026-08-01T00:01:02+00:00'],
  ['2026-08-01T12:30:00-00:00:00.000001', '2026-08-01T12:30:00+00:00'],
  // a date-only string with an offset reads the offset as the time
  ['2026-08-01+05:00', '2026-08-01T05:00:00'],
  // refused
  ['next tuesday', null],
  ['', null],
  ['2026-08-01T', null],
  ['2026-08-0', null],
  ['2026-8-1', null],
  ['2026-08', null],
  [' 2026-08-01', null],
  ['2026-08-01T00:01:02 ', null],
  ['2023-02-29', null],
  ['2026-13-01', null],
  ['0000-01-01', null],
  ['2026-08-01T24:00:00', null],
  ['2026-08-01T00:60', null],
  ['2026-08-01T00:01:60', null],
  ['2026-08-01T00:0102', null],
  ['2026-08-01T00:01:02.', null],
  ['2026-08-01T00:01:02+05:3', null],
  ['2026-08-01T00:01:02+24:00', null],
  ['2026-08-01T00:01:02+05:30+01:00', null],
  ['2026-08-01T00:01:02+-05:00', null],
  ['2026-08-01T00:01:02z', null],
  ['2026-08-01T1', null],
]

describe('pyIsoformat', () => {
  it.each(CASES)('reads %j as Python 3.12 does', (text, expected) => {
    expect(pyIsoformat(text.replaceAll('Z', '+00:00'))).toBe(expected)
  })
})
