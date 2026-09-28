// customer.subscription.deleted: whose records a cancellation disables, and whose it leaves alone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { subscription } from '@/test/fakes.js'
import {
  type WebhookHarness,
  webhookHarness,
  stopWebhookHarness,
  byNumber,
  cancel,
} from '@/test/webhookHarness.js'

let h: WebhookHarness

beforeEach(() => {
  h = webhookHarness()
})

afterEach(stopWebhookHarness)

describe('customer.subscription.deleted', () => {
  it('disables every record', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147, 57, 106, 155, 204])
    await h.handle(cancel({ id: 'evt_cancel', customer: 'cus_1' }))
    // cancel must disable every server record, not just the first
    expect(h.disabledIds().toSorted(byNumber)).toEqual([57, 106, 147, 155, 204])
    // a deleted subscription clears the confirmed-payment flag
    expect(h.rowFor('a@x.com')?.subscribed).toBe(false)
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('5 server record(s)')
  })

  it('leaves access alone when another address still pays', async () => {
    // Jimmy's shape: two customers, one person, and only one of them cancelling.
    //
    // The dead customer's email IS the address the member's Wizarr records live
    // under, so resolving it finds their real, paid-for access. Disabling that
    // because a second, abandoned subscription ended locks out a member who is
    // current.
    h.bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    h.bridge.store.setSubscribed({ email: 'pays@x.com', value: true })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287, 288])

    await h.handle(cancel({ id: 'evt_cancel_one_of_two', customer: 'cus_dead' }))

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    // The dead customer really did stop, even though access is untouched.
    expect(h.rowFor('watches@x.com')?.subscribed).toBe(false)
    const events = h.bridge.store.eventsForEmail({ email: 'watches@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('pays@x.com')
  })

  it('never disables a VIP', async () => {
    // VIP access is a standing grant, not something a subscription pays for.
    //
    // The renewal handler already refuses to touch a VIP's expiry, and the expiry
    // sweep skips them outright, but the cancel handler disabled whatever it
    // resolved. A VIP whose card lapsed therefore lost every server the moment
    // Stripe reported the subscription gone.
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'vip@x.com', inviteCode: 'abc' })
    h.bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147, 57, 106, 155, 204])

    await h.handle(cancel({ id: 'evt_vip_cancel', customer: 'cus_1' }))

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    // The subscription really did end, so the payment flag still clears.
    expect(h.rowFor('vip@x.com')?.subscribed).toBe(false)
    const events = h.bridge.store.eventsForEmail({ email: 'vip@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('VIP')
  })

  it('still disables when the linked address has stopped too', async () => {
    // Once nothing is paying, the guard must get out of the way.
    h.bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    h.bridge.store.setSubscribed({ email: 'pays@x.com', value: false })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287, 288])

    await h.handle(cancel({ id: 'evt_cancel_last_one', customer: 'cus_dead' }))

    expect(h.disabledIds().toSorted(byNumber)).toEqual([287, 288])
  })

  it('cancelling the paying address spares the member the other way round', async () => {
    // The link is directional; the guard must not be.
    //
    // Cancelling the payer while the Plex address itself still carries a live
    // subscription is the same person in the same situation, mirrored.
    h.bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    h.bridge.store.setSubscribed({ email: 'watches@x.com', value: true })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287])

    await h.handle(cancel({ id: 'evt_cancel_payer', customer: 'cus_dead' }))

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('an unlinked member cancelling is unaffected by the guard', async () => {
    // The ordinary case has no links at all and must keep disabling.
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'solo@x.com', inviteCode: 'abc' })
    h.bridge.store.setSubscribed({ email: 'other@x.com', value: true }) // unrelated member
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([12])

    await h.handle(cancel({ id: 'evt_cancel_solo', customer: 'cus_1' }))

    expect(h.disabledIds()).toEqual([12])
  })

  it('keeps access when a second customer at the same address pays', async () => {
    // Danny's shape: re-checked out from scratch instead of fixing the card.
    //
    // Two customers, one email. The old one dies in dunning the night after the
    // new one paid. The cancel used to clear the per-email flags and disable the
    // records the new subscription had just bought.
    h.bridge.store.upsertPending({
      customerId: 'cus_old',
      email: 'a@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    h.bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    h.bridge.stripe.allSubscriptions.mockResolvedValue([
      subscription({ customer: 'cus_old', status: 'canceled' }),
      subscription({ customer: 'cus_new', status: 'active' }),
    ])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([303, 304, 305])
    await h.handle(cancel({ id: 'evt_cancel_old_sibling', customer: 'cus_old' }))
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    const row = h.rowFor('a@x.com')
    expect(row?.subscribed).toBe(true)
    expect(row?.payment_state).toBeNull() // the dead customer's dunning is over
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('still paying under cus_new')
  })

  it('disables when the other customer at the address is not paying', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_old',
      email: 'a@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    h.bridge.stripe.allSubscriptions.mockResolvedValue([
      subscription({ customer: 'cus_old', status: 'canceled' }),
      subscription({ customer: 'cus_new', status: 'past_due' }),
    ])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await h.handle(cancel({ id: 'evt_cancel_both_dead', customer: 'cus_old' }))
    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
    expect(h.rowFor('a@x.com')?.subscribed).toBe(false)
  })

  it('asks Stripe nothing when the address has one customer', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await h.handle(cancel({ id: 'evt_cancel_only_customer', customer: 'cus_1' }))
    expect(h.bridge.stripe.allSubscriptions).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('a cancel with no records is a no-op', async () => {
    h.bridge.stripe.customerEmail.mockResolvedValue('ghost@x.com')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(cancel({ id: 'evt_cancel_orphan', customer: 'cus_missing' }))
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('prefers the stored email over a Stripe lookup', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await h.handle(cancel({ id: 'evt_cancel_mapped', customer: 'cus_1' }))
    // mapping has the email, so no Stripe API round-trip is needed
    expect(h.bridge.stripe.customerEmail).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.findUserIdsByEmail).toHaveBeenCalledExactlyOnceWith('a@x.com')
    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
  })
})
