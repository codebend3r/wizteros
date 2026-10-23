import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { guardOf } from './guard.js'

describe('guardOf', () => {
  const isPoint = guardOf(z.object({ at: z.string(), value: z.number() }))

  it('passes a value the schema accepts, extra fields and all', () => {
    expect(isPoint({ at: '2026-10-19T00:00:00', value: 1, extra: true })).toBe(true)
  })

  it('refuses a value the schema does not', () => {
    expect(isPoint({ at: '2026-10-19T00:00:00', value: '1' })).toBe(false)
    expect(isPoint(null)).toBe(false)
  })
})
