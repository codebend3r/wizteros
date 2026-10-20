import { describe, expect, it } from 'vitest'
import { strongestTag } from '@/standing.js'

describe('strongestTag', () => {
  it('is null when no address is tagged', () => {
    expect(strongestTag([])).toBeNull()
    expect(strongestTag([null, null])).toBeNull()
  })

  it('lets a ban outrank a standing grant, and a grant outrank hvu', () => {
    expect(strongestTag(['vip', 'banned'])).toBe('banned')
    expect(strongestTag(['banned', 'vip'])).toBe('banned')
    expect(strongestTag([null, 'hvu', 'vip'])).toBe('vip')
    expect(strongestTag(['hvu', null])).toBe('hvu')
  })
})
