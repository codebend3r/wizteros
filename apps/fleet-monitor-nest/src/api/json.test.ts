import { describe, expect, it } from 'vitest'
import { toJson } from '@/api/json.js'
import { pydanticTimestamp } from '@/time.js'

describe('pydanticTimestamp', () => {
  // Both strings are what FastAPI 0.141 with pydantic 2.13 put on the wire for
  // the same instants.
  it('writes a whole second with no fraction and a Z', () => {
    expect(pydanticTimestamp(new Date(Date.UTC(2026, 8, 26, 7, 0, 0)))).toBe('2026-09-26T07:00:00Z')
  })

  it('writes a fraction as six digits', () => {
    expect(pydanticTimestamp(new Date(Date.UTC(2026, 8, 26, 7, 0, 1, 123)))).toBe(
      '2026-09-26T07:00:01.123000Z',
    )
  })
})

describe('toJson', () => {
  it('writes every Date in a view the way FastAPI did, however deep', () => {
    const at = new Date(Date.UTC(2026, 8, 26, 7, 0, 0))
    expect(
      JSON.parse(toJson({ at, nested: [{ closed_at: at, opened_at: null }], ratio: 0.5 })),
    ).toEqual({
      at: '2026-09-26T07:00:00Z',
      nested: [{ closed_at: '2026-09-26T07:00:00Z', opened_at: null }],
      ratio: 0.5,
    })
  })

  it('leaves strings that merely look like timestamps alone', () => {
    expect(toJson({ key: '2026-09-26T07:00:00+00:00' })).toBe('{"key":"2026-09-26T07:00:00+00:00"}')
  })
})
