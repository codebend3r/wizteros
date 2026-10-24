import { describe, expect, it } from 'vitest'
import { banResultSchema } from './bridge.js'
import { guardOf } from './guard.js'

const isBanResult = guardOf(banResultSchema)
const result = { email: 'a@x.com', disabled: 2, canceled: 0, cancel_at: null }

describe('ban response contract', () => {
  it.each(['scheduled', 'already_scheduled', 'absent', 'failed', 'partial'])(
    'accepts %s explicitly',
    (billing_status) => {
      expect(isBanResult({ ...result, billing_status })).toBe(true)
    },
  )
  it('rejects missing or unknown billing outcomes', () => {
    expect(isBanResult(result)).toBe(false)
    expect(isBanResult({ ...result, billing_status: 'success' })).toBe(false)
  })
})
