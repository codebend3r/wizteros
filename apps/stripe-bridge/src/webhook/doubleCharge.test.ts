// A member who checks out again instead of fixing a failed card: the old
// subscription is retired so Stripe's next retry cannot charge them twice.

import { afterEach, describe, expect, it } from 'vitest'
import { subscription, TEST_SETTINGS } from '@/test/fakes.js'
import {
  cancel,
  checkout,
  paymentFailed,
  stopWebhookHarness,
  type WebhookHarness,
  webhookHarness,
} from '@/test/webhookHarness.js'

afterEach(stopWebhookHarness)

const PORTAL = 'https://billing.test/p/login/abc'

/** Stripe holding `cus_new` active and `cus_old` past due, both at a@x.com. */
const twoCustomers = (h: WebhookHarness): void => {
  const subscriptions = [
    subscription({ id: 'sub_new', customer: 'cus_new', status: 'active' }),
    subscription({ id: 'sub_old', customer: 'cus_old', status: 'past_due' }),
  ]
  h.bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_new', 'cus_old'])
  h.bridge.stripe.subscriptionsFor.mockImplementation(async (customer) =>
    subscriptions.filter((sub) => sub.customer === customer),
  )
  h.bridge.stripe.allSubscriptions.mockResolvedValue(subscriptions)
  h.bridge.stripe.openInvoiceIds.mockResolvedValue(['in_old'])
}

/** The store as a member who once checked out under `customerId` leaves it. */
const mapped = (h: WebhookHarness, customerId: string): void => {
  h.bridge.store.upsertPending({
    customerId,
    email: 'a@x.com',
    inviteCode: customerId,
    tier: 'silver',
  })
}

describe('checkout over a customer still in dunning', () => {
  it('cancels the old subscription and voids its invoice', async () => {
    const h = webhookHarness()
    h.wizarrMints('abc')
    twoCustomers(h)
    mapped(h, 'cus_old')
    await h.handle(
      checkout({
        id: 'evt_recheckout',
        session: {
          id: 'cs_new',
          customer: 'cus_new',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'silver' },
        },
      }),
    )
    expect(h.bridge.stripe.cancelNow).toHaveBeenCalledExactlyOnceWith('sub_old')
    expect(h.bridge.stripe.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_old')
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    const subjects = h.bridge.mailer.sendAlert.mock.calls.map(([alert]) => alert.subject)
    expect(subjects).toContain('cancelled 1 duplicate subscription(s) for a@x.com')
  })

  it("the cancel's own webhook then keeps the access just paid for", async () => {
    const h = webhookHarness()
    h.wizarrMints('abc')
    twoCustomers(h)
    mapped(h, 'cus_old')
    h.bridge.wizarr.listUsers.mockResolvedValue([{ id: 7, email: 'a@x.com', server: 'Meleys' }])
    await h.handle(
      checkout({
        id: 'evt_recheckout_then_cancel',
        session: {
          id: 'cs_new',
          customer: 'cus_new',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'silver' },
        },
      }),
    )
    await h.handle(cancel({ id: 'evt_old_deleted', customer: 'cus_old' }))
    expect(h.disabledIds()).toEqual([])
    expect(h.rowFor('a@x.com')?.subscribed).toBe(true)
  })

  it('a Stripe failure still completes the checkout and alerts the double charge risk', async () => {
    const h = webhookHarness()
    h.wizarrMints('abc')
    h.bridge.stripe.customerIdsForEmail.mockRejectedValue(new Error('Stripe unavailable'))
    await h.handle(
      checkout({
        id: 'evt_recheckout_stripe_down',
        session: {
          id: 'cs_new',
          customer: 'cus_new',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'silver' },
        },
      }),
    )
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_recheckout_stripe_down' })).toBe(true)
    const subjects = h.bridge.mailer.sendAlert.mock.calls.map(([alert]) => alert.subject)
    expect(subjects).toContain('DOUBLE CHARGE RISK: a@x.com already pays under cus_new')
  })
})

describe('payment_failed on a duplicate of a paying customer', () => {
  /** A declined charge on the old customer. */
  const declined = (id: string) =>
    paymentFailed({
      id,
      invoice: { id: 'in_old', customer: 'cus_old', customer_email: 'a@x.com', attempt_count: 4 },
    })

  it('retires it instead of flagging dunning or mailing the member', async () => {
    const h = webhookHarness({ settings: { ...TEST_SETTINGS, billingPortalUrl: PORTAL } })
    twoCustomers(h)
    mapped(h, 'cus_old')
    mapped(h, 'cus_new')
    await h.handle(declined('evt_dup_failed'))
    expect(h.bridge.stripe.cancelNow).toHaveBeenCalledExactlyOnceWith('sub_old')
    expect(h.bridge.stripe.voidInvoice).toHaveBeenCalledExactlyOnceWith('in_old')
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
    expect(h.bridge.mailer.sendPaymentFailed).not.toHaveBeenCalled()
    const subjects = h.bridge.mailer.sendAlert.mock.calls.map(([alert]) => alert.subject)
    expect(subjects).toEqual(['cancelled 1 duplicate subscription(s) for a@x.com'])
  })

  it('alerts the double charge when Stripe refuses the cancel', async () => {
    const h = webhookHarness()
    twoCustomers(h)
    mapped(h, 'cus_old')
    mapped(h, 'cus_new')
    h.bridge.stripe.cancelNow.mockRejectedValue(new Error('Stripe unavailable'))
    await h.handle(declined('evt_dup_failed_refused'))
    const alert = h.bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.subject).toBe('DOUBLE CHARGE RISK: a@x.com already pays under cus_new')
    expect(alert?.body).toContain('attempt 4')
    expect(alert?.body).toContain('in_old')
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
  })

  it('alerts the double charge when nothing at the address is left to retire', async () => {
    const h = webhookHarness({ settings: { ...TEST_SETTINGS, billingPortalUrl: PORTAL } })
    twoCustomers(h)
    mapped(h, 'cus_old')
    mapped(h, 'cus_new')
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([])
    await h.handle(declined('evt_dup_failed_nothing'))
    const subjects = h.bridge.mailer.sendAlert.mock.calls.map(([alert]) => alert.subject)
    expect(subjects).toEqual(['DOUBLE CHARGE RISK: a@x.com already pays under cus_new'])
    expect(h.bridge.mailer.sendPaymentFailed).not.toHaveBeenCalled()
  })
})

describe('payment_failed on the only customer', () => {
  const declined = paymentFailed({
    id: 'evt_only_failed',
    invoice: { id: 'in_1', customer: 'cus_1', customer_email: 'a@x.com' },
  })

  it('mails the member the portal link when one is configured', async () => {
    const h = webhookHarness({ settings: { ...TEST_SETTINGS, billingPortalUrl: PORTAL } })
    mapped(h, 'cus_1')
    await h.handle(declined)
    expect(h.bridge.mailer.sendPaymentFailed).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      portalUrl: PORTAL,
    })
    expect(h.rowFor('a@x.com')?.payment_state).toBe('past_due')
  })

  it('mails the member nothing without a portal link', async () => {
    const h = webhookHarness()
    mapped(h, 'cus_1')
    await h.handle(declined)
    expect(h.bridge.mailer.sendPaymentFailed).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
  })
})
