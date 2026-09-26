import { describe, expect, it } from 'vitest'
import { addSeconds, epochSeconds, isoformat, parseIso, secondsBetween } from '@/time.js'

describe('isoformat', () => {
  it('writes what datetime.isoformat() wrote for an aware UTC instant', () => {
    expect(isoformat(new Date(Date.UTC(2026, 8, 26, 7, 53, 26, 123)))).toBe(
      '2026-09-26T07:53:26.123000+00:00',
    )
  })

  it('leaves the fraction off a whole second, as Python does', () => {
    expect(isoformat(new Date(Date.UTC(2026, 8, 26, 7, 0, 0)))).toBe('2026-09-26T07:00:00+00:00')
  })

  it('sorts among Python-written rows exactly as the instants do', () => {
    const written = [
      '2026-09-26T07:00:00.999999+00:00',
      isoformat(new Date(Date.UTC(2026, 8, 26, 7, 0, 1))),
      '2026-09-26T07:00:01.000001+00:00',
      isoformat(new Date(Date.UTC(2026, 8, 26, 7, 0, 1, 500))),
    ]
    expect(written.toSorted()).toEqual(written)
  })
})

describe('parseIso', () => {
  it('reads the microsecond form down to the millisecond', () => {
    expect(parseIso('2026-09-26T07:53:26.123456+00:00').getTime()).toBe(
      Date.UTC(2026, 8, 26, 7, 53, 26, 123),
    )
  })

  it('reads a whole second, a Z suffix, and no suffix at all as UTC', () => {
    const second = Date.UTC(2026, 8, 26, 7, 0, 0)
    expect(parseIso('2026-09-26T07:00:00+00:00').getTime()).toBe(second)
    expect(parseIso('2026-09-26T07:00:00Z').getTime()).toBe(second)
    expect(parseIso('2026-09-26T07:00:00').getTime()).toBe(second)
  })

  it('applies a non-UTC offset', () => {
    expect(parseIso('2026-09-26T03:00:00-04:00').getTime()).toBe(Date.UTC(2026, 8, 26, 7))
  })

  it('round-trips what isoformat writes', () => {
    const at = new Date(Date.UTC(2026, 8, 26, 7, 53, 26, 7))
    expect(parseIso(isoformat(at)).getTime()).toBe(at.getTime())
  })

  it('refuses text that is not a timestamp', () => {
    expect(() => parseIso('yesterday')).toThrow(RangeError)
  })
})

describe('arithmetic', () => {
  const at = new Date(Date.UTC(2026, 8, 26, 7, 0, 0, 900))

  it('floors to whole epoch seconds like int(at.timestamp())', () => {
    expect(epochSeconds(at)).toBe(Math.floor(Date.UTC(2026, 8, 26, 7) / 1000))
  })

  it('moves by seconds and measures the distance back', () => {
    const later = addSeconds({ at, seconds: 90.5 })
    expect(secondsBetween({ from: at, to: later })).toBe(90.5)
  })
})
