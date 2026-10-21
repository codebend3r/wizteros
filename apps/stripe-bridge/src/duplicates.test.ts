import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { retireDuplicates } from '@/duplicates.js'
import { asBridge, type FakeBridge, fakeBridge, subscription } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

let bridge: FakeBridge

beforeEach(() => {
  bridge = fakeBridge({ dbPath: tempDbPath() })
  bridge.store.init()
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTempDirs()
})

describe('retireDuplicates', () => {
  it('cancels only the other customers in dunning and voids their open invoices', async () => {
    bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_new', 'cus_old', 'cus_gone'])
    bridge.stripe.subscriptionsFor.mockImplementation(async (customer) =>
      customer === 'cus_old'
        ? [subscription({ id: 'sub_old', customer, status: 'past_due' })]
        : [subscription({ id: `sub_${customer}`, customer, status: 'canceled' })],
    )
    bridge.stripe.openInvoiceIds.mockResolvedValue(['in_old'])
    const retired = await retireDuplicates({
      bridge: asBridge(bridge),
      email: 'a@x.com',
      payingUnder: 'cus_new',
    })
    expect(retired).toEqual({
      status: 'retired',
      retired: [{ subscription: 'sub_old', customer: 'cus_old', invoices: ['in_old'] }],
    })
    // The paying customer is never even looked at.
    expect(bridge.stripe.subscriptionsFor).not.toHaveBeenCalledWith('cus_new')
    expect(bridge.stripe.cancelNow).toHaveBeenCalledExactlyOnceWith('sub_old')
    expect(bridge.stripe.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_old')
    expect(bridge.store.eventsForEmail({ email: 'a@x.com' })[0]?.action).toBe('Duplicate cancelled')
    const alert = bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.body).toContain('sub_old on cus_old; voided in_old')
  })

  it('does nothing, and says nothing, when no duplicate is in dunning', async () => {
    bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_new', 'cus_other'])
    bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ status: 'active' })])
    const retired = await retireDuplicates({
      bridge: asBridge(bridge),
      email: 'a@x.com',
      payingUnder: 'cus_new',
    })
    expect(retired).toEqual({ status: 'none' })
    expect(bridge.stripe.cancelNow).not.toHaveBeenCalled()
    expect(bridge.mailer.sendAlert).not.toHaveBeenCalled()
    expect(bridge.store.eventsForEmail({ email: 'a@x.com' })).toEqual([])
  })

  it('answers failed, and never throws, when Stripe refuses', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_new', 'cus_old'])
    bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ status: 'past_due' })])
    bridge.stripe.cancelNow.mockRejectedValue(new Error('Stripe unavailable'))
    const retired = await retireDuplicates({
      bridge: asBridge(bridge),
      email: 'a@x.com',
      payingUnder: 'cus_new',
    })
    expect(retired).toEqual({ status: 'failed' })
    expect(bridge.mailer.sendAlert).not.toHaveBeenCalled()
  })
})
