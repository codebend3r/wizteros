// A tag on any of a person's addresses governs the webhooks for all of them.
//
// An admin tags the row the members list shows, which is the Plex account;
// Stripe's events arrive under the address it bills. Read only under the
// payer, a ban let a renewal through and a VIP was time-boxed and disabled.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordsUnder } from '@/test/fakes.js'
import {
  cancel,
  checkout,
  invoicePaid,
  stopWebhookHarness,
  type WebhookHarness,
  webhookHarness,
} from '@/test/webhookHarness.js'

let h: WebhookHarness

beforeEach(() => {
  h = webhookHarness()
})

afterEach(stopWebhookHarness)

/** pays@x.com is billed; the invite it was issued was redeemed by watches@x.com. */
const payerWatchingElsewhere = (): void => {
  h.bridge.store.upsertPending({
    customerId: 'cus_1',
    email: 'pays@x.com',
    inviteCode: 'INV1',
    tier: 'bronze',
  })
  h.bridge.wizarr.listUsers.mockResolvedValue(recordsUnder({ email: 'watches@x.com', ids: [7, 8] }))
  h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: '<User 7>' }])
}

describe('standing across addresses', () => {
  it('a ban on the Plex account stops a renewal billed to the payer', async () => {
    payerWatchingElsewhere()
    h.bridge.store.setMemberTag({ email: 'watches@x.com', tag: 'banned' })

    await h.handle(invoicePaid({ id: 'evt_banned_payer', customer: 'cus_1', email: 'pays@x.com' }))

    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    const events = h.bridge.store.eventsForEmail({ email: 'pays@x.com' })
    expect(events[0]?.detail).toBe('banned; access not extended')
  })

  it("a VIP tag on the Plex account leaves the payer's renewal unstamped", async () => {
    payerWatchingElsewhere()
    h.bridge.store.setMemberTag({ email: 'watches@x.com', tag: 'vip' })

    await h.handle(invoicePaid({ id: 'evt_vip_payer', customer: 'cus_1', email: 'pays@x.com' }))

    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it("a VIP tag on the Plex account survives the payer's cancellation", async () => {
    payerWatchingElsewhere()
    h.bridge.store.setMemberTag({ email: 'watches@x.com', tag: 'vip' })

    await h.handle(cancel({ id: 'evt_vip_cancel_payer', customer: 'cus_1' }))

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    expect(h.bridge.store.eventsForEmail({ email: 'pays@x.com' })[0]?.detail).toContain('VIP')
  })

  it('a VIP tag on a linked address governs a renewal on the other half', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'pays@x.com', inviteCode: 'abc' })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.store.setMemberTag({ email: 'watches@x.com', tag: 'vip' })
    h.bridge.wizarr.listUsers.mockResolvedValue(recordsUnder({ email: 'watches@x.com', ids: [7] }))

    await h.handle(invoicePaid({ id: 'evt_vip_linked', customer: 'cus_1', email: 'pays@x.com' }))

    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('a ban on the Plex account blocks a fresh checkout by the payer', async () => {
    payerWatchingElsewhere()
    h.bridge.store.setMemberTag({ email: 'watches@x.com', tag: 'banned' })
    h.wizarrMints('NEW1')

    await h.handle(
      checkout({
        id: 'evt_banned_checkout_payer',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'pays@x.com' },
          metadata: { tier: 'bronze' },
        },
      }),
    )

    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).not.toHaveBeenCalled()
    expect(h.bridge.store.eventsForEmail({ email: 'pays@x.com' })[0]?.action).toBe(
      'Checkout blocked',
    )
  })

  it('an untagged person is unaffected', async () => {
    payerWatchingElsewhere()
    h.bridge.store.setMemberTag({ email: 'someone@x.com', tag: 'banned' })

    await h.handle(invoicePaid({ id: 'evt_untagged', customer: 'cus_1', email: 'pays@x.com' }))

    expect(h.setExpiryIds()).toEqual([7, 8])
  })
})
