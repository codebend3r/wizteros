import { Logger } from '@nestjs/common'
import { parseIso } from '@wizteros/server-common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CreateTransport,
  type MailMessage,
  type SmtpTransportOptions,
  smtpMailer,
} from '@/clients/mailer.js'
import { TierScopeEmpty } from '@/invites.js'
import { resolveUserIds } from '@/members.js'
import { asBridge, type FakeBridge, fakeBridge, subscription } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { WizarrLibrary } from '@/types.js'
import { customerEmail, handleEvent } from '@/webhook/handlers.js'

// Every tier shares from Meleys alone; the trailing Vermithor entry is a
// retired server's "(switch to Meleys)" mirror and must never reach an invite.
const FIXTURE_LIBRARIES: readonly WizarrLibrary[] = [
  { id: 17, name: '05. TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 20, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 22, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 24, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 37, name: '99. Tutorials', server_id: 2, server_name: 'Meleys', enabled: true },
  {
    id: 41,
    name: '01. TV Shows (switch to Meleys)',
    server_id: 1,
    server_name: 'Vermithor',
    enabled: true,
  },
]

const DAY_MS = 86_400_000

// A fresh bridge per test: a temp SQLite db, a faked Wizarr, Stripe and
// mailer. Operator alerts are faked for every test: a checkout now mails the
// admin, and nothing here may reach a real SMTP host. No plex.tv by default:
// the library list is trusted as given.
let bridge: FakeBridge

beforeEach(() => {
  bridge = fakeBridge({ dbPath: tempDbPath() })
  bridge.store.init()
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTempDirs()
})

const handle = (event: unknown): Promise<void> => handleEvent({ bridge: asBridge(bridge), event })

/** A checkout.session.completed event carrying `session`. */
const checkout = ({ id, session }: { id: string; session: Record<string, unknown> }) => ({
  type: 'checkout.session.completed',
  id,
  data: { object: session },
})

/** Wizarr answering with the fixture libraries and minting invite `code`. */
const wizarrMints = (code: string): void => {
  bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
  bridge.wizarr.createInvite.mockResolvedValue({ code, url: `http://x/j/${code}` })
}

const rowFor = (email: string) => bridge.store.allCustomerRows().get(email)

const setExpiryIds = (): number[] => bridge.wizarr.setExpiry.mock.calls.map(([call]) => call.userId)
const setExpiryValues = (): string[] =>
  bridge.wizarr.setExpiry.mock.calls.map(([call]) => call.expires ?? '')
const disabledIds = (): number[] => bridge.wizarr.disableUser.mock.calls.map(([id]) => id)
const byNumber = (a: number, b: number): number => a - b

describe('checkout.session.completed', () => {
  it('a brand-new member is invited for its tier', async () => {
    bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
    bridge.wizarr.createInvite.mockResolvedValue({
      code: 'abc',
      url: 'http://wizarr-lan:5690/j/abc',
    })
    bridge.wizarr.findUsersByEmail.mockResolvedValue([]) // no existing records yet
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20, 22, 24],
      allowDownloads: false,
    })
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
    // brand-new member has no records to time-box; invite redemption sets expiry
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(bridge.store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('abc')
    // checkout is the confirmed-payment signal that drives "Subscribed Monthly"
    expect(rowFor('a@x.com')?.subscribed).toBe(true)
    const events = bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Signed up')
    expect(events[0]?.detail).toContain('silver')
  })

  it('an existing member keeps access when their servers are covered', async () => {
    // Redeeming re-scopes the share in place on the share server, so a member
    // already on Meleys alone keeps access through the invite window.
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await handle(
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
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it("an existing covered member's expiry resets to ACCESS_DURATION", async () => {
    // A covered member keeps access without ever redeeming the new invite, so
    // the checkout itself must stamp the paid expiry (now + ACCESS_DURATION)
    // on every surviving record — otherwise a short pre-signup window (e.g. the
    // 14-day Invited backfill) survives the purchase.
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await handle(
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
    expect(setExpiryIds().toSorted(byNumber)).toEqual([57, 147])
    const expiries = new Set(setExpiryValues())
    expect(expiries.size).toBe(1) // one absolute expiry applied uniformly
    const expected = Date.now() + 35 * DAY_MS
    expect(Math.abs(parseIso([...expiries][0] ?? '').getTime() - expected)).toBeLessThan(60_000)
  })

  it('a VIP member is never time-boxed', async () => {
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Meleys' },
      { id: 57, server: 'Meleys' },
    ])
    await handle(
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
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('an existing member has every record reset when a server drops', async () => {
    // Wizarr has no per-server unshare (disable severs the whole plex.tv
    // friendship), so a legacy member still on the retired servers is fully
    // reset; redeeming the emailed invite re-grants the tier on Meleys alone.
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 147, server: 'Vermithor' }, // retired
      { id: 57, server: 'Meleys' },
      { id: 106, server: 'Vhagar' }, // retired
      { id: 155, server: 'Syrax' }, // retired
      { id: 204, server: 'Caraxes' }, // retired
    ])
    await handle(
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
    expect(disabledIds().toSorted(byNumber)).toEqual([57, 106, 147, 155, 204])
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    // the invite email still goes out — it is the re-join path
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('a brand-new member has nothing disabled', async () => {
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('a checkout without an email creates nothing', async () => {
    await handle(checkout({ id: 'evt_no_email', session: { id: 'cs_1', customer: 'cus_1' } }))
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(bridge.mailer.sendInvite).not.toHaveBeenCalled()
  })

  it('falls back to the customer_email field', async () => {
    // Some checkout sessions carry customer_email instead of customer_details.
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
      checkout({
        id: 'evt_fallback_email',
        session: { id: 'cs_1', customer: 'cus_1', customer_email: 'b@x.com' },
      }),
    )
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'b@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('clears a dunning flag left by the previous cycle', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    wizarrMints('abc2')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(rowFor('a@x.com')?.payment_state).toBeNull()
  })

  it('a checkout without tier metadata defaults to bronze', async () => {
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
      checkout({
        id: 'evt_no_tier',
        session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
      }),
    )
    // bronze: no 4K library, downloads off (kid shows is not 4K, so it's included)
    expect(bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 22, 24],
      allowDownloads: false,
    })
  })

  it('a gold checkout enables downloads', async () => {
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [1, 2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20, 22, 24, 41],
      allowDownloads: true,
    })
  })

  it('a youth checkout is scoped to the youth libraries only', async () => {
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
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
    bridge.wizarr.listLibraries.mockResolvedValue([])
    await expect(
      handle(
        checkout({
          id: 'evt_no_libraries',
          session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
        }),
      ),
    ).rejects.toBeInstanceOf(TierScopeEmpty)
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(bridge.mailer.sendInvite).not.toHaveBeenCalled()
    // The line that says the webhook was abandoned on purpose.
    const errors = vi.mocked(Logger.prototype.error).mock.calls.map(([line]) => String(line))
    expect(errors).toContain(
      'no libraries resolved for bronze tier checkout cs_1; aborting for retry',
    )
  })

  it('records the tier for the customer', async () => {
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
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
    expect(bridge.store.customerRow({ email: 'a@x.com' })?.tier).toBe('gold')
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
    wizarrMints('abc')
    // a record on a server bronze does not cover -> disable-first path
    bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 7, server: 'Vhagar' }])
    bridge.wizarr.disableUser.mockRejectedValueOnce(new Error('ReadTimeout: wizarr slow'))
    await expect(handle(event)).rejects.toThrow('wizarr slow')
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledOnce()

    await handle(event)
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    expect(bridge.wizarr.disableUser).toHaveBeenLastCalledWith(7)
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
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    bridge.mailer.sendInvite.mockRejectedValueOnce(new Error('smtp down'))
    await expect(handle(event)).rejects.toThrow('smtp down')

    await handle(event)
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledTimes(2)
    expect(bridge.mailer.sendInvite).toHaveBeenLastCalledWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('a checkout by a banned member issues nothing and alerts', async () => {
    bridge.store.setMemberTag({ email: 'banned@x.com', tag: 'banned' })
    bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])

    await handle(
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

    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(bridge.mailer.sendInvite).not.toHaveBeenCalled()
    expect(bridge.store.getMapping({ customerId: 'cus_1' })).toBeNull()
    expect(bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendAlert.mock.calls[0]?.[0].body.toLowerCase()).toContain('banned@x.com')
    const events = bridge.store.eventsForEmail({ email: 'banned@x.com' })
    expect(events[0]?.action).toBe('Checkout blocked')
    expect(events[0]?.detail).toContain('banned')
    // Marked processed: a retry must not raise the alarm a second time.
    expect(bridge.store.isEventProcessed({ eventId: 'evt_checkout_banned' })).toBe(true)
  })

  it('mails the admin once per signup', async () => {
    // The operator hears about every tier signup, with enough to act on it
    // (who, what tier, how much, and the same link the member got) without
    // opening Stripe.
    wizarrMints('abc')
    bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    const session = {
      id: 'cs_1',
      customer: 'cus_1',
      amount_total: 800,
      currency: 'cad',
      customer_details: { email: 'a@x.com' },
      metadata: { tier: 'silver' },
    }
    await handle(checkout({ id: 'evt_signup_1', session }))

    expect(bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    const alert = bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.subject).toBe('a@x.com signed up for silver')
    expect(alert?.body).toContain('8.00 CAD')
    expect(alert?.body).toContain('cs_1')
    expect(alert?.body).toContain('cus_1')
    expect(alert?.body).toContain('http://inv.test/j/abc')

    // Stripe re-delivers the same session under a new event id after a
    // timeout: the invite is reused, the member is not re-mailed, and
    // neither is the admin.
    await handle(checkout({ id: 'evt_signup_1_retry', session }))
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendAlert).toHaveBeenCalledOnce()
  })
})

/** An invoice.paid event for a renewal (or `billingReason`). */
const invoicePaid = ({
  id,
  customer,
  email,
  billingReason = 'subscription_cycle',
}: {
  id: string
  customer: string
  email: string
  billingReason?: string
}) => ({
  type: 'invoice.paid',
  id,
  data: { object: { customer, customer_email: email, billing_reason: billingReason } },
})

describe('invoice.paid', () => {
  it('skips the first charge', async () => {
    await handle(
      invoicePaid({
        id: 'evt_inv_skip',
        customer: 'cus_1',
        email: 'a@x.com',
        billingReason: 'subscription_create',
      }),
    )
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('a renewal extends', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    bridge.store.setSubscribed({ email: 'a@x.com', value: false }) // prove the renewal restores it
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 10])
    await handle(invoicePaid({ id: 'evt_inv_cycle', customer: 'cus_1', email: 'a@x.com' }))
    // renewal sets expiry on every server record, all to the same absolute date
    expect(setExpiryIds().toSorted(byNumber)).toEqual([9, 10])
    expect(new Set(setExpiryValues()).size).toBe(1) // one expiry applied uniformly
    // a paid invoice re-affirms the confirmed-payment flag
    expect(rowFor('a@x.com')?.subscribed).toBe(true)
    const events = bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Payment received')
    expect(events[0]?.detail).toContain('access extended to')
  })

  it("a renewal leaves a VIP's expiry alone", async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'vip@x.com', inviteCode: 'abc' })
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 10]) // would be stamped if not VIP
    await handle(invoicePaid({ id: 'evt_inv_vip', customer: 'cus_1', email: 'vip@x.com' }))
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    // the payment itself is still acknowledged
    expect(rowFor('vip@x.com')?.subscribed).toBe(true)
    const events = bridge.store.eventsForEmail({ email: 'vip@x.com' })
    expect(events[0]?.action).toBe('Payment received')
  })

  it('a renewal on a linked address extends the Plex records', async () => {
    // The whole point: the money arrives at one address, access lives at another.
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'pays@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockImplementation(async (email) =>
      email === 'watches@x.com' ? [7] : [],
    )

    await handle(invoicePaid({ id: 'evt_renew', customer: 'cus_1', email: 'pays@x.com' }))

    expect(bridge.wizarr.setExpiry.mock.lastCall?.[0].userId).toBe(7)
  })

  it('a payment with no records reissues an invite', async () => {
    // The failure this exists to stop: a member pays, holds no Wizarr records
    // (their window lapsed while an earlier invoice went unpaid, or the payment
    // landed on a second Stripe customer), and the bridge shrugs. They stay
    // locked out with money taken. A paid invoice with nothing to extend must
    // put a fresh tier-scoped invite in their inbox.
    bridge.store.upsertPending({
      customerId: 'cus_lapsed',
      email: 'lapsed@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    wizarrMints('new1')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([])
    await handle(
      invoicePaid({ id: 'evt_inv_orphan', customer: 'cus_lapsed', email: 'lapsed@x.com' }),
    )
    // re-invited at the tier they pay for, and told about it
    expect(bridge.wizarr.createInvite).toHaveBeenCalledExactlyOnceWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 22, 24],
      allowDownloads: false,
    })
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'lapsed@x.com',
      inviteUrl: 'http://inv.test/j/new1',
    })
    expect(bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    // nothing to extend, so no expiry write, and the new code is the stored one
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(bridge.store.getMapping({ customerId: 'cus_lapsed' })?.invite_code).toBe('new1')
    const actions = bridge.store
      .eventsForEmail({ email: 'lapsed@x.com' })
      .map((event) => event.action)
    expect(actions).toContain('Access restored')
  })

  it('a payment with no records still recovers an unmapped member', async () => {
    // No customer_map row at all (an admin-invited member, or a brand-new
    // second customer): recovery must not depend on the bridge already knowing
    // them, and an unrecorded tier falls back to bronze rather than nothing.
    wizarrMints('new2')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(
      invoicePaid({ id: 'evt_inv_unmapped', customer: 'cus_new', email: 'second@x.com' }),
    )
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'second@x.com',
      inviteUrl: 'http://inv.test/j/new2',
    })
    expect(rowFor('second@x.com')?.tier).toBe('bronze')
  })

  it('recovery never touches a VIP', async () => {
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(invoicePaid({ id: 'evt_inv_vip_orphan', customer: 'cus_vip', email: 'vip@x.com' }))
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(bridge.mailer.sendInvite).not.toHaveBeenCalled()
  })

  it('a signup invoice clears dunning even though it is skipped', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    await handle(
      invoicePaid({
        id: 'evt_signup_paid',
        customer: 'cus_1',
        email: 'a@x.com',
        billingReason: 'subscription_create',
      }),
    )
    expect(rowFor('a@x.com')?.payment_state).toBeNull()
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled() // signup expiry is the checkout's job
  })

  it('never extends a banned member', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'banned@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    bridge.store.setMemberTag({ email: 'banned@x.com', tag: 'banned' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147])

    await handle(invoicePaid({ id: 'evt_paid_banned', customer: 'cus_1', email: 'banned@x.com' }))

    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    const events = bridge.store.eventsForEmail({ email: 'banned@x.com' })
    expect(events[0]?.action).toBe('Payment received')
    expect(events[0]?.detail).toContain('banned')
  })
})

/** An invoice.payment_failed event carrying `invoice`. */
const paymentFailed = ({ id, invoice }: { id: string; invoice: Record<string, unknown> }) => ({
  type: 'invoice.payment_failed',
  id,
  data: { object: invoice },
})

describe('invoice.payment_failed', () => {
  it('flags dunning without touching access', async () => {
    // Stripe retries a declined charge for weeks. The member keeps the period
    // they paid for, but must stop reading as healthy in the admin UI.
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    await handle(
      paymentFailed({
        id: 'evt_failed_1',
        invoice: { id: 'in_1', customer: 'cus_1', customer_email: 'a@x.com' },
      }),
    )
    const row = rowFor('a@x.com')
    expect(row?.payment_state).toBe('past_due')
    expect(row?.subscribed).toBe(true) // still paid up for this period
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    const actions = bridge.store.eventsForEmail({ email: 'a@x.com' }).map((event) => event.action)
    expect(actions).toContain('Payment failed')
  })

  it('a successful retry clears the dunning flag', async () => {
    // The exact sequence that lost a member their library: charge fails, then
    // the retry succeeds. The success has to undo the failure.
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await handle(
      paymentFailed({
        id: 'evt_failed_2',
        invoice: { id: 'in_2', customer: 'cus_1', customer_email: 'a@x.com' },
      }),
    )
    await handle(invoicePaid({ id: 'evt_retry_ok', customer: 'cus_1', email: 'a@x.com' }))
    expect(rowFor('a@x.com')?.payment_state).toBeNull()
    expect(bridge.wizarr.setExpiry).toHaveBeenCalledOnce() // and the window was extended
  })

  it('mails the admin with what Stripe knows', async () => {
    // A declined charge used to be a store flag and a log line. The admin has
    // to hear about it, and the mail has to say whether the member can even
    // watch right now: the one who paid once and never redeemed is the one
    // whose card failing nobody would otherwise notice.
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([])
    await handle(
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
    expect(bridge.mailer.sendAlert).toHaveBeenCalledOnce()
    const alert = bridge.mailer.sendAlert.mock.calls[0]?.[0]
    expect(alert?.subject).toBe('a@x.com missed a payment')
    expect(alert?.body).toContain('8.00 CAD')
    expect(alert?.body).toContain('attempt 3')
    expect(alert?.body).toContain('2026-09-18')
    expect(alert?.body).toContain('in_9')
    expect(alert?.body).toContain('NO server access')
    // The history row carries the same facts, so the member page tells it too.
    const events = bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.detail).toContain('8.00 CAD')
  })

  it('the mail says when access is still held', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([7])
    await handle(
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
    const body = bridge.mailer.sendAlert.mock.calls[0]?.[0].body
    expect(body).toContain('still hold server access')
    expect(body).toContain('Stripe has given up')
  })
})

describe('customer.subscription.updated', () => {
  it('syncs the dunning flag both ways', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    await handle({
      type: 'customer.subscription.updated',
      id: 'evt_sub_past_due',
      data: { object: { customer: 'cus_1', status: 'past_due' } },
    })
    expect(rowFor('a@x.com')?.payment_state).toBe('past_due')
    await handle({
      type: 'customer.subscription.updated',
      id: 'evt_sub_active',
      data: { object: { customer: 'cus_1', status: 'active' } },
    })
    expect(rowFor('a@x.com')?.payment_state).toBeNull()
  })
})

/** A customer.subscription.deleted event for `customer`. */
const cancel = ({ id, customer }: { id: string; customer: string }) => ({
  type: 'customer.subscription.deleted',
  id,
  data: { object: { customer } },
})

describe('customer.subscription.deleted', () => {
  it('disables every record', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147, 57, 106, 155, 204])
    await handle(cancel({ id: 'evt_cancel', customer: 'cus_1' }))
    // cancel must disable every server record, not just the first
    expect(disabledIds().toSorted(byNumber)).toEqual([57, 106, 147, 155, 204])
    // a deleted subscription clears the confirmed-payment flag
    expect(rowFor('a@x.com')?.subscribed).toBe(false)
    const events = bridge.store.eventsForEmail({ email: 'a@x.com' })
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
    bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    bridge.store.setSubscribed({ email: 'pays@x.com', value: true })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287, 288])

    await handle(cancel({ id: 'evt_cancel_one_of_two', customer: 'cus_dead' }))

    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
    // The dead customer really did stop, even though access is untouched.
    expect(rowFor('watches@x.com')?.subscribed).toBe(false)
    const events = bridge.store.eventsForEmail({ email: 'watches@x.com' })
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
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'vip@x.com', inviteCode: 'abc' })
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([147, 57, 106, 155, 204])

    await handle(cancel({ id: 'evt_vip_cancel', customer: 'cus_1' }))

    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
    // The subscription really did end, so the payment flag still clears.
    expect(rowFor('vip@x.com')?.subscribed).toBe(false)
    const events = bridge.store.eventsForEmail({ email: 'vip@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('VIP')
  })

  it('still disables when the linked address has stopped too', async () => {
    // Once nothing is paying, the guard must get out of the way.
    bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    bridge.store.setSubscribed({ email: 'pays@x.com', value: false })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287, 288])

    await handle(cancel({ id: 'evt_cancel_last_one', customer: 'cus_dead' }))

    expect(disabledIds().toSorted(byNumber)).toEqual([287, 288])
  })

  it('cancelling the paying address spares the member the other way round', async () => {
    // The link is directional; the guard must not be.
    //
    // Cancelling the payer while the Plex address itself still carries a live
    // subscription is the same person in the same situation, mirrored.
    bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'watches@x.com',
      inviteCode: 'INVOLD',
    })
    bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
    })
    bridge.store.setSubscribed({ email: 'watches@x.com', value: true })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([287])

    await handle(cancel({ id: 'evt_cancel_payer', customer: 'cus_dead' }))

    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('an unlinked member cancelling is unaffected by the guard', async () => {
    // The ordinary case has no links at all and must keep disabling.
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'solo@x.com', inviteCode: 'abc' })
    bridge.store.setSubscribed({ email: 'other@x.com', value: true }) // unrelated member
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([12])

    await handle(cancel({ id: 'evt_cancel_solo', customer: 'cus_1' }))

    expect(disabledIds()).toEqual([12])
  })

  it('keeps access when a second customer at the same address pays', async () => {
    // Danny's shape: re-checked out from scratch instead of fixing the card.
    //
    // Two customers, one email. The old one dies in dunning the night after the
    // new one paid. The cancel used to clear the per-email flags and disable the
    // records the new subscription had just bought.
    bridge.store.upsertPending({
      customerId: 'cus_old',
      email: 'a@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    bridge.stripe.allSubscriptions.mockResolvedValue([
      subscription({ customer: 'cus_old', status: 'canceled' }),
      subscription({ customer: 'cus_new', status: 'active' }),
    ])
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([303, 304, 305])
    await handle(cancel({ id: 'evt_cancel_old_sibling', customer: 'cus_old' }))
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
    const row = rowFor('a@x.com')
    expect(row?.subscribed).toBe(true)
    expect(row?.payment_state).toBeNull() // the dead customer's dunning is over
    const events = bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Canceled')
    expect(events[0]?.detail).toContain('still paying under cus_new')
  })

  it('disables when the other customer at the address is not paying', async () => {
    bridge.store.upsertPending({
      customerId: 'cus_old',
      email: 'a@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    bridge.stripe.allSubscriptions.mockResolvedValue([
      subscription({ customer: 'cus_old', status: 'canceled' }),
      subscription({ customer: 'cus_new', status: 'past_due' }),
    ])
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await handle(cancel({ id: 'evt_cancel_both_dead', customer: 'cus_old' }))
    expect(bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
    expect(rowFor('a@x.com')?.subscribed).toBe(false)
  })

  it('asks Stripe nothing when the address has one customer', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await handle(cancel({ id: 'evt_cancel_only_customer', customer: 'cus_1' }))
    expect(bridge.stripe.allSubscriptions).not.toHaveBeenCalled()
    expect(bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('a cancel with no records is a no-op', async () => {
    bridge.stripe.customerEmail.mockResolvedValue('ghost@x.com')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(cancel({ id: 'evt_cancel_orphan', customer: 'cus_missing' }))
    expect(bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('prefers the stored email over a Stripe lookup', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await handle(cancel({ id: 'evt_cancel_mapped', customer: 'cus_1' }))
    // mapping has the email, so no Stripe API round-trip is needed
    expect(bridge.stripe.customerEmail).not.toHaveBeenCalled()
    expect(bridge.wizarr.findUserIdsByEmail).toHaveBeenCalledExactlyOnceWith('a@x.com')
    expect(bridge.wizarr.disableUser).toHaveBeenCalledExactlyOnceWith(9)
  })
})

describe('handleEvent', () => {
  it('drops a duplicate event', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const event = invoicePaid({ id: 'evt_inv_cycle_dup', customer: 'cus_1', email: 'a@x.com' })
    await handle(event)
    await handle(event)
    expect(bridge.wizarr.setExpiry).toHaveBeenCalledOnce()
    expect(bridge.wizarr.setExpiry.mock.lastCall?.[0].userId).toBe(9)
  })

  it('a failed event is not marked processed', async () => {
    // A crash mid-handler (e.g. Wizarr resolves zero libraries) must not mark
    // the event processed, so Stripe's retry of the same event id can still
    // be handled instead of being dropped as a dupe.
    const event = checkout({
      id: 'evt_retry_me',
      session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
    })
    bridge.wizarr.listLibraries.mockResolvedValue([])
    await expect(handle(event)).rejects.toBeInstanceOf(TierScopeEmpty)
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(bridge.store.isEventProcessed({ eventId: 'evt_retry_me' })).toBe(false)

    // fix the fake and re-handle the SAME event id -- it must not be skipped
    wizarrMints('abc')
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await handle(event)
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
  })

  it('an unknown event type is still marked processed', async () => {
    // A type missing from the table falls through untouched, and is marked so
    // Stripe stops redelivering it.
    await handle({ type: 'customer.created', id: 'evt_unknown', data: { object: {} } })
    expect(bridge.store.isEventProcessed({ eventId: 'evt_unknown' })).toBe(true)
    expect(bridge.wizarr.listLibraries).not.toHaveBeenCalled()
  })

  it('a malformed event (no type) throws and is not marked processed', async () => {
    // A 500, so Stripe redelivers it.
    await expect(handle({ id: 'evt_malformed', data: { object: {} } })).rejects.toThrow(
      'the Stripe event carries no type',
    )
    expect(bridge.store.isEventProcessed({ eventId: 'evt_malformed' })).toBe(false)
  })
})

describe('customerEmail', () => {
  it('reads the email off the Stripe customer, and tolerates a missing one', async () => {
    // The SDK's customer object is read by the Stripe port (a deleted customer
    // or one with no email on file answers null); the handlers only see that.
    bridge.stripe.customerEmail.mockResolvedValueOnce('c@x.com')
    expect(await customerEmail({ bridge: asBridge(bridge), customerId: 'cus_1' })).toBe('c@x.com')
    expect(bridge.stripe.customerEmail).toHaveBeenLastCalledWith('cus_1')

    bridge.stripe.customerEmail.mockResolvedValueOnce(null)
    expect(await customerEmail({ bridge: asBridge(bridge), customerId: 'cus_1' })).toBeNull()
  })
})

describe('resolveUserIds', () => {
  it('falls back from email to the invite', async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    // email miss (Stripe email != Plex email) -> resolve via the stored invite code
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([7, 8])
    const ids = await resolveUserIds({
      bridge: asBridge(bridge),
      customerId: 'cus_1',
      email: 'a@x.com',
    })
    expect(ids).toEqual([7, 8])
    expect(bridge.wizarr.findUserIdsByInvite).toHaveBeenCalledExactlyOnceWith('abc')
  })

  it('uses a linked address before the invite code', async () => {
    // A stated identity beats an inferred one, and beats an invite nobody used.
    //
    // This is the renewal half of the re-typed-address case: the paying customer
    // has no Wizarr record under its own email and holds an invite that was
    // never redeemed, so both existing lookups come back empty and the member's
    // access is never extended.
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'pays@x.com', inviteCode: 'abc' })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockImplementation(async (email) =>
      email === 'watches@x.com' ? [7, 8] : [],
    )
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([99])

    const ids = await resolveUserIds({
      bridge: asBridge(bridge),
      customerId: 'cus_1',
      email: 'pays@x.com',
    })

    expect(ids).toEqual([7, 8])
    expect(bridge.wizarr.findUserIdsByInvite).not.toHaveBeenCalled()
  })

  it("still prefers the member's own email over a link", async () => {
    bridge.store.upsertPending({ customerId: 'cus_1', email: 'pays@x.com', inviteCode: 'abc' })
    bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1])
    const ids = await resolveUserIds({
      bridge: asBridge(bridge),
      customerId: 'cus_1',
      email: 'pays@x.com',
    })
    expect(ids).toEqual([1])
    expect(bridge.wizarr.findUserIdsByEmail).toHaveBeenCalledExactlyOnceWith('pays@x.com')
  })
})

describe('the invite mail', () => {
  it('is sent over SMTP with STARTTLS', async () => {
    // Stands in for smtplib.SMTP: records how the connection was opened and
    // every message handed to it.
    const opened: SmtpTransportOptions[] = []
    const sent: MailMessage[] = []
    const createTransport: CreateTransport = (options) => {
      opened.push(options)
      return {
        sendMail: async (message) => {
          sent.push(message)
          return {}
        },
        close: () => {},
      }
    }
    await smtpMailer({
      smtp: { host: 'smtp.test', port: 587, user: 'u', pass: 'p', from: 'server@test' },
      alertAddresses: [],
      inviteDays: 14,
      createTransport,
    }).sendInvite({ to: 'to@x.com', inviteUrl: 'http://inv.test/j/abc' })

    expect(opened.map(({ host, port }) => [host, port])).toEqual([['smtp.test', 587]])
    expect(opened[0]?.requireTLS).toBe(true) // starttls before login
    expect(opened[0]?.auth).toEqual({ user: 'u', pass: 'p' })
    const [message] = sent
    expect(message?.to).toBe('to@x.com')
    expect(message?.from).toBe('server@test')
    expect(message?.subject).toBe('Your Westeroz access link')
    // multipart/alternative: plain-text fallback plus the styled HTML part,
    // both carrying the invite link.
    expect(message?.text).toContain('http://inv.test/j/abc')
    expect(message?.html).toContain('href="http://inv.test/j/abc"')
    expect(message?.html).toContain('Set up your account')
    // both parts steer a brand-new member to create their Plex account with
    // the address the email was delivered to, so the bridge's email joins hold
    expect(message?.text).toContain('Plex account')
    expect(message?.text).toContain('same email address')
  })
})
