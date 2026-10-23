import { describe, expect, it } from 'vitest'
import { hostStatusSchema } from './fleet.js'
import { guardOf } from './guard.js'

describe('hostStatusSchema', () => {
  const isHostStatus = guardOf(hostStatusSchema)

  it('accepts the three verdicts the monitor reaches', () => {
    expect(['ok', 'warn', 'unknown'].every(isHostStatus)).toBe(true)
  })

  it('refuses anything else', () => {
    expect(['down', '', null, 1].some(isHostStatus)).toBe(false)
  })
})
