// checkout.session.completed: the invite a payment mints, once per session, and what happens to the records the member already holds.

import { Logger } from '@nestjs/common'
import { parseIso } from '@wizteros/server-common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TierScopeEmpty } from '@/invites.js'
import {
  FIXTURE_LIBRARIES,
  DAY_MS,
  type WebhookHarness,
  webhookHarness,
  stopWebhookHarness,
  byNumber,
  checkout,
} from '@/test/webhookHarness.js'

let h: WebhookHarness

beforeEach(() => {
  h = webhookHarness()
})

afterEach(stopWebhookHarness)

describe('checkout.session.completed', () => {
  it('a brand-new member is invited for its tier', async () => {
    h.bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
    h.bridge.wizarr.createInvite.mockResolvedValue({
      code: 'abc',
      url: 'http://wizarr-lan:5690/j/abc',
    })
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([]) // no existing records yet
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_checkout_1',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'silver' },
        },
      }),
    )
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20, 22, 24],
      allowDownloads: false,
    })
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
    // brand-new member has no records to time-box; invite redemption sets expiry
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(h.bridge.store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('abc')
    // checkout is the confirmed-payment signal that drives "Subscribed Monthly"
    expect(h.rowFor('a@x.com')?.subscribed).toBe(true)
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Signed up')
    expect(events[0]?.detail).toContain('silver')
  })

  it('an existing member keeps access when their servers are covered', async () => {
    // Redeeming re-scopes the share in place on the share server, so a member
    // already on Meleys alone keeps access through the invite window.
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await h.handle(
      checkout({
        id: 'evt_checkout_covered',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'bronze' },
        },
      }),
    )
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it("an existing covered member's expiry resets to ACCESS_DURATION", async () => {
    // A covered member keeps access without ever redeeming the new invite, so
    // the checkout itself must stamp the paid expiry (now + ACCESS_DURATION)
    // on every surviving record — otherwise a short pre-signup window (e.g. the
    // 14-day Invited backfill) survives the purchase.
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await h.handle(
      checkout({
        id: 'evt_checkout_covered_expiry',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'gold' },
        },
      }),
    )
    expect(h.setExpiryIds().toSorted(byNumber)).toEqual([57, 147])
    const expiries = new Set(h.setExpiryValues())
    expect(expiries.size).toBe(1) // one absolute expiry applied uniformly
    const expected = Date.now() + 35 * DAY_MS
    expect(Math.abs(parseIso([...expiries][0] ?? '').getTime() - expected)).toBeLessThan(60_000)
  })

  it('a VIP member is never time-boxed', async () => {
    h.bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await h.handle(
      checkout({
        id: 'evt_checkout_vip',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'VIP@x.com' },
          metadata: { tier: 'gold' },
        },
      }),
    )
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('an existing member has every record reset when a server drops', async () => {
    // Wizarr has no per-server unshare (disable severs the whole plex.tv
    // friendship), so a legacy member still on the retired servers is fully
    // reset; redeeming the emailed invite re-grants the tier on Meleys alone.
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Vermithor' }, // retired
      { id: 57, server: 'Meleys' },
      { id: 106, server: 'Vhagar' }, // retired
      { id: 155, server: 'Syrax' }, // retired
      { id: 204, server: 'Caraxes' }, // retired
    ])
    await h.handle(
      checkout({
        id: 'evt_checkout_existing',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'bronze' },
        },
      }),
    )
    // every record is disabled (account-wide reset), none merely time-boxed
    expect(h.disabledIds().toSorted(byNumber)).toEqual([57, 106, 147, 155, 204])
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    // the invite email still goes out — it is the re-join path
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('a brand-new member has nothing disabled', async () => {
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_checkout_fresh',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'new@x.com' },
          metadata: { tier: 'youth' },
        },
      }),
    )
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('a checkout without an email creates nothing', async () => {
    await h.handle(checkout({ id: 'evt_no_email', session: { id: 'cs_1', customer: 'cus_1' } }))
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).not.toHaveBeenCalled()
  })

  it('falls back to the customer_email field', async () => {
    // Some checkout sessions carry customer_email instead of customer_details.
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_fallback_email',
        session: { id: 'cs_1', customer: 'cus_1', customer_email: 'b@x.com' },
      }),
    )
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'b@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('clears a dunning flag left by the previous cycle', async () => {
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    h.bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    h.wizarrMints('abc2')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_checkout_after_dunning',
        session: {
          id: 'cs_9',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'bronze' },
        },
      }),
    )
    expect(h.rowFor('a@x.com')?.payment_state).toBeNull()
  })

  it('a checkout without tier metadata defaults to bronze', async () => {
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_no_tier',
        session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
      }),
    )
    // bronze: no 4K library, downloads off (kid shows is not 4K, so it's included)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 22, 24],
      allowDownloads: false,
    })
  })

  it('a gold checkout enables downloads', async () => {
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_gold',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'gold' },
        },
      }),
    )
    // Gold spans the fleet, so the Vermithor library and its server join the scope.
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [1, 2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20, 22, 24, 41],
      allowDownloads: true,
    })
  })

  it('a youth checkout is scoped to the youth libraries only', async () => {
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_youth',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'youth' },
        },
      }),
    )
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [20, 22, 24],
      allowDownloads: true,
    })
  })

  it('a checkout with no libraries throws so Stripe retries', async () => {
    // Wizarr returned no libraries at all -- resolving zero library_ids must
    // not silently issue an invite to nothing; throw so the route 500s and
    // Stripe retries the event later.
    h.bridge.wizarr.listLibraries.mockResolvedValue([])
    await expect(
      h.handle(
        checkout({
          id: 'evt_no_libraries',
          session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
        }),
      ),
    ).rejects.toBeInstanceOf(TierScopeEmpty)
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).not.toHaveBeenCalled()
    // The line that says the webhook was abandoned on purpose.
    const errors = vi.mocked(Logger.prototype.error).mock.calls.map(([line]) => String(line))
    expect(errors).toContain(
      'no libraries resolved for bronze tier checkout cs_1; aborting for retry',
    )
  })

  it('records the tier for the customer', async () => {
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(
      checkout({
        id: 'evt_tier_1',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'a@x.com' },
          metadata: { tier: 'gold' },
        },
      }),
    )
    expect(h.bridge.store.customerRow({ email: 'a@x.com' })?.tier).toBe('gold')
  })

  it('a retry after a mid-handler failure reuses the invite', async () => {
    // The real incident: createInvite and the email both succeeded, then
    // disableUser timed out against a slow Wizarr. The event was never marked
    // processed, so Stripe retried and the handler issued a SECOND invite and
    // a SECOND email for one checkout. The retry must reuse the invite already
    // recorded for the session id and not re-send the email.
    const event = checkout({
      id: 'evt_slow_disable',
      session: {
        id: 'cs_slow',
        customer: 'cus_1',
        customer_details: { email: 'a@x.com' },
        metadata: { tier: 'bronze' },
      },
    })
    h.wizarrMints('abc')
    // a record on a server bronze does not cover -> disable-first path
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 7, server: 'Vhagar' }])
    h.bridge.wizarr.disableUser.mockRejectedValueOnce(new Error('ReadTimeout: wizarr slow'))
    await expect(h.handle(event)).rejects.toThrow('wizarr slow')
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledOnce()

    await h.handle(event)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    expect(h.bridge.wizarr.disableUser).toHaveBeenLastCalledWith(7)
  })

  it('a retry resends an invite email that never went out', async () => {
    // Mirror image of the above: the invite exists but the SMTP send failed,
    // so the member has a link they never received. The retry must reuse the
    // same code and actually deliver it.
    const event = checkout({
      id: 'evt_smtp_down',
      session: {
        id: 'cs_smtp',
        customer: 'cus_1',
        customer_details: { email: 'a@x.com' },
        metadata: { tier: 'bronze' },
      },
    })
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    h.bridge.mailer.sendInvite.mockRejectedValueOnce(new Error('smtp down'))
    await expect(h.handle(event)).rejects.toThrow('smtp down')

    await h.handle(event)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledTimes(2)
    expect(h.bridge.mailer.sendInvite).toHaveBeenLastCalledWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('a checkout by a banned member issues nothing and alerts', async () => {
    h.bridge.store.setMemberTag({ email: 'banned@x.com', tag: 'banned' })
    h.bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])

    await h.handle(
      checkout({
        id: 'evt_checkout_banned',
        session: {
          id: 'cs_1',
          customer: 'cus_1',
          customer_details: { email: 'Banned@x.com' },
          metadata: { tier: 'gold' },
        },
      }),
    )

    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.mailer.sendInvite).not.toHaveBeenCalled()
    expect(h.bridge.store.getMapping({ customerId: 'cus_1' })).toBeNull()
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendAlert.mock.calls[0]?.[0].body.toLowerCase()).toContain(
      'banned@x.com',
    )
    const events = h.bridge.store.eventsForEmail({ email: 'banned@x.com' })
    expect(events[0]?.action).toBe('Checkout blocked')
    expect(events[0]?.detail).toContain('banned')
    // Marked processed: a retry must not raise the alarm a second time.
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_checkout_banned' })).toBe(true)
  })

  it('mails the admin once per signup', async () => {
    // The operator hears about every tier signup, with enough to act on it
    // (who, what tier, how much, and the same link the member got) without
    // opening Stripe.
    h.wizarrMints('abc')
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    const session = {
      id: 'cs_1',
      customer: 'cus_1',
      amount_total: 800,
      currency: 'cad',
      customer_details: { email: 'a@x.com' },
      metadata: { tier: 'silver' },
    }
    await h.handle(checkout({ id: 'evt_signup_1', session }))

    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    const alert = h.bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.subject).toBe('a@x.com signed up for silver')
    expect(alert?.body).toContain('8.00 CAD')
    expect(alert?.body).toContain('cs_1')
    expect(alert?.body).toContain('cus_1')
    expect(alert?.body).toContain('http://inv.test/j/abc')

    // Stripe re-delivers the same session under a new event id after a
    // timeout: the invite is reused, the member is not re-mailed, and
    // neither is the admin.
    await h.handle(checkout({ id: 'evt_signup_1_retry', session }))
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
  })
})

/** An invoice.paid event for a renewal (or `billingReason`). */
