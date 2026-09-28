// invoice.paid, invoice.payment_failed and customer.subscription.updated: what a renewal extends or restores, and how dunning is flagged.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type WebhookHarness,
  webhookHarness,
  stopWebhookHarness,
  byNumber,
  invoicePaid,
  paymentFailed,
} from '@/test/webhookHarness.js'

let h: WebhookHarness

beforeEach(() => {
  h = webhookHarness()
})

afterEach(stopWebhookHarness)

describe('invoice.paid', () => {
  it('skips the first charge', async () => {
    await h.handle(
      invoicePaid({
        id: 'evt_inv_skip',
        customer: 'cus_1',
        email: 'a@x.com',
        billingReason: 'subscription_create',
      }),
    )
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('a renewal extends', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    h.bridge.store.setSubscribed({ email: 'a@x.com', value: false }) // prove the renewal restores it
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 10])
    await h.handle(invoicePaid({ id: 'evt_inv_cycle', customer: 'cus_1', email: 'a@x.com' }))
    // renewal sets expiry on every server record, all to the same absolute date
    expect(h.setExpiryIds().toSorted(byNumber)).toEqual([9, 10])
    expect(new Set(h.setExpiryValues()).size).toBe(1) // one expiry applied uniformly
    // a paid invoice re-affirms the confirmed-payment flag
    expect(h.rowFor('a@x.com')?.subscribed).toBe(true)
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Payment received')
    expect(events[0]?.detail).toContain('access extended to')
  })

  it("a renewal leaves a VIP's expiry alone", async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'vip@x.com', inviteCode: 'abc' })
    h.bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 10]) // would be stamped if not VIP
    await h.handle(invoicePaid({ id: 'evt_inv_vip', customer: 'cus_1', email: 'vip@x.com' }))
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    // the payment itself is still acknowledged
    expect(h.rowFor('vip@x.com')?.subscribed).toBe(true)
    const events = h.bridge.store.eventsForEmail({ email: 'vip@x.com' })
    expect(events[0]?.action).toBe('Payment received')
  })

  it('a renewal on a linked address extends the Plex records', async () => {
    // The whole point: the money arrives at one address, access lives at another.
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'pays@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockImplementation(async (email) =>
      email === 'watches@x.com' ? [7] : [],
    )

    await h.handle(invoicePaid({ id: 'evt_renew', customer: 'cus_1', email: 'pays@x.com' }))

    expect(h.bridge.wizarr.setExpiry.mock.lastCall?.[0].userId).toBe(7)
  })

  it('a payment with no records reissues an invite', async () => {
    // The failure this exists to stop: a member pays, holds no Wizarr records
    // (their window lapsed while an earlier invoice went unpaid, or the payment
    // landed on a second Stripe customer), and the bridge shrugs. They stay
    // locked out with money taken. A paid invoice with nothing to extend must
    // put a fresh tier-scoped invite in their inbox.
    h.bridge.store.upsertPending({
      customerId: 'cus_lapsed',
      email: 'lapsed@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    h.wizarrMints('new1')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByInvite.mockResolvedValue([])
    await h.handle(
      invoicePaid({ id: 'evt_inv_orphan', customer: 'cus_lapsed', email: 'lapsed@x.com' }),
    )
    // re-invited at the tier they pay for, and told about it
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 22, 24],
      allowDownloads: false,
    })
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'lapsed@x.com',
      inviteUrl: 'http://inv.test/j/new1',
    })
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    // nothing to extend, so no expiry write, and the new code is the stored one
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(h.bridge.store.getMapping({ customerId: 'cus_lapsed' })?.invite_code).toBe('new1')
    const actions = h.bridge.store
      .eventsForEmail({ email: 'lapsed@x.com' })
      .map((event) => event.action)
    expect(actions).toContain('Access restored')
  })

  it('a payment with no records still recovers an unmapped member', async () => {
    // No customer_map row at all (an admin-invited member, or a brand-new
    // second customer): recovery must not depend on the bridge already knowing
    // them, and an unrecorded tier falls back to bronze rather than nothing.
    h.wizarrMints('new2')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      invoicePaid({ id: 'evt_inv_unmapped', customer: 'cus_new', email: 'second@x.com' }),
    )
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'second@x.com',
      inviteUrl: 'http://inv.test/j/new2',
    })
    expect(h.rowFor('second@x.com')?.tier).toBe('bronze')
  })

  it('recovery never touches a VIP', async () => {
    h.bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      invoicePaid({ id: 'evt_inv_vip_orphan', customer: 'cus_vip', email: 'vip@x.com' }),
    )
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).not.toHaveBeenCalled()
  })

  it('a signup invoice clears dunning even though it is skipped', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    await h.handle(
      invoicePaid({
        id: 'evt_signup_paid',
        customer: 'cus_1',
        email: 'a@x.com',
        billingReason: 'subscription_create',
      }),
    )
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled() // signup expiry is the checkout's job
  })

  it('never extends a banned member', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'banned@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.store.setMemberTag({ email: 'banned@x.com', tag: 'banned' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147])

    await h.handle(invoicePaid({ id: 'evt_paid_banned', customer: 'cus_1', email: 'banned@x.com' }))

    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    const events = h.bridge.store.eventsForEmail({ email: 'banned@x.com' })
    expect(events[0]?.action).toBe('Payment received')
    expect(events[0]?.detail).toContain('banned')
  })
})

/** An invoice.payment_failed event carrying `invoice`. */

describe('invoice.payment_failed', () => {
  it('flags dunning without touching access', async () => {
    // Stripe retries a declined charge for weeks. The member keeps the period
    // they paid for, but must stop reading as healthy in the admin UI.
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    await h.handle(
      paymentFailed({
        id: 'evt_failed_1',
        invoice: { id: 'in_1', customer: 'cus_1', customer_email: 'a@x.com' },
      }),
    )
    const row = h.rowFor('a@x.com')
    expect(row?.payment_state).toBe('past_due')
    expect(row?.subscribed).toBe(true) // still paid up for this period
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    const actions = h.bridge.store.eventsForEmail({ email: 'a@x.com' }).map((event) => event.action)
    expect(actions).toContain('Payment failed')
  })

  it('a successful retry clears the dunning flag', async () => {
    // The exact sequence that lost a member their library: charge fails, then
    // the retry succeeds. The success has to undo the failure.
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await h.handle(
      paymentFailed({
        id: 'evt_failed_2',
        invoice: { id: 'in_2', customer: 'cus_1', customer_email: 'a@x.com' },
      }),
    )
    await h.handle(invoicePaid({ id: 'evt_retry_ok', customer: 'cus_1', email: 'a@x.com' }))
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledOnce() // and the window was extended
  })

  it('mails the admin with what Stripe knows', async () => {
    // A declined charge used to be a store flag and a log line. The admin has
    // to hear about it, and the mail has to say whether the member can even
    // watch right now: the one who paid once and never redeemed is the one
    // whose card failing nobody would otherwise notice.
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByInvite.mockResolvedValue([])
    await h.handle(
      paymentFailed({
        id: 'evt_failed_mail',
        invoice: {
          id: 'in_9',
          customer: 'cus_1',
          customer_email: 'a@x.com',
          amount_due: 800,
          currency: 'cad',
          attempt_count: 3,
          next_payment_attempt: 1789689600,
        },
      }),
    )
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    const alert = h.bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.subject).toBe('a@x.com missed a payment')
    expect(alert?.body).toContain('8.00 CAD')
    expect(alert?.body).toContain('attempt 3')
    expect(alert?.body).toContain('2026-09-18')
    expect(alert?.body).toContain('in_9')
    expect(alert?.body).toContain('NO server access')
    // The history row carries the same facts, so the member page tells it too.
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.detail).toContain('8.00 CAD')
  })

  it('the mail says when access is still held', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([7])
    await h.handle(
      paymentFailed({
        id: 'evt_failed_held',
        invoice: {
          id: 'in_10',
          customer: 'cus_1',
          customer_email: 'a@x.com',
          amount_due: 800,
          currency: 'cad',
          attempt_count: 1,
          next_payment_attempt: null,
        },
      }),
    )
    const body = h.bridge.mailer.sendAlert.mock.calls[0]?.[0].body
    expect(body).toContain('still hold server access')
    expect(body).toContain('Stripe has given up')
  })
})

describe('customer.subscription.updated', () => {
  it('syncs the dunning flag both ways', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    await h.handle({
      type: 'customer.subscription.updated',
      id: 'evt_sub_past_due',
      data: { object: { customer: 'cus_1', status: 'past_due' } },
    })
    expect(h.rowFor('a@x.com')?.payment_state).toBe('past_due')
    await h.handle({
      type: 'customer.subscription.updated',
      id: 'evt_sub_active',
      data: { object: { customer: 'cus_1', status: 'active' } },
    })
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
  })
})

/** A customer.subscription.deleted event for `customer`. */
