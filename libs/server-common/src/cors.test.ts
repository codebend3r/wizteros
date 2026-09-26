import { describe, expect, it } from 'vitest'
import { starletteCors } from './cors.js'

describe('starletteCors', () => {
  it("merges the configured headers into Starlette's safelisted set, sorted", () => {
    expect(
      starletteCors({ origin: '*', methods: ['GET'], headers: ['Authorization'] }).allowedHeaders,
    ).toEqual(['Accept', 'Accept-Language', 'Authorization', 'Content-Language', 'Content-Type'])
  })

  it('does not repeat a header that is already safelisted', () => {
    const { allowedHeaders } = starletteCors({
      origin: ['https://example.com'],
      methods: ['GET', 'POST'],
      headers: ['Authorization', 'Content-Type'],
    })
    expect(allowedHeaders.filter((header) => header === 'Content-Type')).toHaveLength(1)
  })

  it("keeps Starlette's ten minute preflight cache and 200 preflight status", () => {
    const options = starletteCors({ origin: '*', methods: ['GET'], headers: [] })
    expect(options.maxAge).toBe(600)
    expect(options.optionsSuccessStatus).toBe(200)
  })
})
