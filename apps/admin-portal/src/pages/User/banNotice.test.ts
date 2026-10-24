import { describe, expect, test } from 'bun:test'
import { formatBanNotice } from './banNotice'
import type { BanResult } from '@wizteros/wire'

const result: BanResult = {
  email: 'a@x.com',
  disabled: 1,
  canceled: 0,
  cancel_at: null,
  billing_status: 'absent',
}

describe('ban notices preserve billing outcomes', () => {
  test.each(['failed', 'partial'] as const)(
    '%s requires operator action, not a claim that billing is absent',
    (billing_status) => {
      const notice = formatBanNotice({ ...result, billing_status })
      expect(notice).toContain('Stripe')
      expect(notice).not.toContain('no subscription')
      expect(notice).toContain('1 server record disabled')
    },
  )

  test('only absence claims that there is no subscription', () => {
    expect(formatBanNotice(result)).toContain('no subscription to cancel')
  })

  test.each(['scheduled', 'already_scheduled'] as const)(
    '%s includes its known date',
    (billing_status) => {
      const cancel_at = '2026-09-21T14:13:20+00:00'
      expect(formatBanNotice({ ...result, billing_status, cancel_at })).toContain(
        new Date(cancel_at).toLocaleDateString(),
      )
      expect(formatBanNotice({ ...result, billing_status })).not.toContain('no subscription')
    },
  )
})
