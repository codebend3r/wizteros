import { afterEach, describe, expect, it } from 'vitest'
import { banResultSchema } from '@wizteros/wire'
import { harness, post, stopServed } from '@/test/adminHarness.js'
import { subscription } from '@/test/fakes.js'

afterEach(stopServed)

describe('ban billing outcomes', () => {
  it('distinguishes a billing outage from no subscription', async () => {
    const h = await harness()
    h.bridge.stripe.customerIdsForEmail.mockRejectedValue(new Error('offline'))
    const answer = await post({ h, url: '/admin/ban', payload: { email: 'a@x.com' } })
    expect(banResultSchema.parse(answer.json())).toMatchObject({
      billing_status: 'failed',
      canceled: 0,
      cancel_at: null,
    })
  })

  it('retains an already-scheduled cancellation date', async () => {
    const h = await harness()
    h.bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_1'])
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([
      subscription({ id: 'sub_1', cancel_at_period_end: true, cancel_at: 1790000000 }),
    ])
    const answer = await post({ h, url: '/admin/ban', payload: { email: 'a@x.com' } })
    expect(banResultSchema.parse(answer.json())).toMatchObject({
      billing_status: 'already_scheduled',
      canceled: 0,
      cancel_at: '2026-09-21T14:13:20+00:00',
    })
    expect(h.bridge.stripe.cancelAtPeriodEnd).not.toHaveBeenCalled()
  })

  it('keeps successful cancellations and continues after a failure', async () => {
    const h = await harness()
    h.bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_1'])
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([
      subscription({ id: 'sub_fail' }),
      subscription({ id: 'sub_ok' }),
    ])
    h.bridge.stripe.cancelAtPeriodEnd.mockImplementation(async (id) => {
      if (id === 'sub_fail') throw new Error('offline')
      return subscription({ id, cancel_at_period_end: true, cancel_at: 1790000000 })
    })
    const answer = await post({ h, url: '/admin/ban', payload: { email: 'a@x.com' } })
    expect(banResultSchema.parse(answer.json())).toMatchObject({
      billing_status: 'partial',
      canceled: 1,
      cancel_at: '2026-09-21T14:13:20+00:00',
    })
    expect(h.bridge.stripe.cancelAtPeriodEnd.mock.calls).toEqual([['sub_fail'], ['sub_ok']])
    expect(h.bridge.store.getMemberTag({ email: 'a@x.com' })).toBe('banned')
  })
})
