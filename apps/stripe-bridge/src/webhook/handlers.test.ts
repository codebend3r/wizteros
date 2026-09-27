// handleEvent's envelope handling and dedupe, the helpers the handlers share, and the invite mail.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CreateTransport,
  type MailMessage,
  type SmtpTransportOptions,
  smtpMailer,
} from '@/clients/mailer.js'
import { TierScopeEmpty } from '@/invites.js'
import { resolveUserIds } from '@/members.js'
import { asBridge } from '@/test/fakes.js'
import { customerEmail } from '@/webhook/handlers.js'
import {
  type WebhookHarness,
  webhookHarness,
  stopWebhookHarness,
  checkout,
  invoicePaid,
} from '@/test/webhookHarness.js'

let h: WebhookHarness

beforeEach(() => {
  h = webhookHarness()
})

afterEach(stopWebhookHarness)

describe('handleEvent', () => {
  it('drops a duplicate event', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const event = invoicePaid({ id: 'evt_inv_cycle_dup', customer: 'cus_1', email: 'a@x.com' })
    await h.handle(event)
    await h.handle(event)
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledOnce()
    expect(h.bridge.wizarr.setExpiry.mock.lastCall?.[0].userId).toBe(9)
  })

  it('a failed event is not marked processed', async () => {
    // A crash mid-handler (e.g. Wizarr resolves zero libraries) must not mark
    // the event processed, so Stripe's retry of the same event id can still
    // be handled instead of being dropped as a dupe.
    const event = checkout({
      id: 'evt_retry_me',
      session: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
    })
    h.bridge.wizarr.listLibraries.mockResolvedValue([])
    await expect(h.handle(event)).rejects.toBeInstanceOf(TierScopeEmpty)
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_retry_me' })).toBe(false)

    // fix the fake and re-handle the SAME event id -- it must not be skipped
    h.wizarrMints('abc')
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    await h.handle(event)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
  })

  it('an unknown event type is still marked processed', async () => {
    // A type missing from the table falls through untouched, and is marked so
    // Stripe stops redelivering it.
    await h.handle({ type: 'customer.created', id: 'evt_unknown', data: { object: {} } })
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_unknown' })).toBe(true)
    expect(h.bridge.wizarr.listLibraries).not.toHaveBeenCalled()
  })

  it('a malformed event (no type) throws and is not marked processed', async () => {
    // A 500, so Stripe redelivers it.
    await expect(h.handle({ id: 'evt_malformed', data: { object: {} } })).rejects.toThrow(
      'the Stripe event carries no type',
    )
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_malformed' })).toBe(false)
  })
})

describe('customerEmail', () => {
  it('reads the email off the Stripe customer, and tolerates a missing one', async () => {
    // The SDK's customer object is read by the Stripe port (a deleted customer
    // or one with no email on file answers null); the handlers only see that.
    h.bridge.stripe.customerEmail.mockResolvedValueOnce('c@x.com')
    expect(await customerEmail({ bridge: asBridge(h.bridge), customerId: 'cus_1' })).toBe('c@x.com')
    expect(h.bridge.stripe.customerEmail).toHaveBeenLastCalledWith('cus_1')

    h.bridge.stripe.customerEmail.mockResolvedValueOnce(null)
    expect(await customerEmail({ bridge: asBridge(h.bridge), customerId: 'cus_1' })).toBeNull()
  })
})

describe('resolveUserIds', () => {
  it('falls back from email to the invite', async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'abc' })
    // email miss (Stripe email != Plex email) -> resolve via the stored invite code
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByInvite.mockResolvedValue([7, 8])
    const ids = await resolveUserIds({
      bridge: asBridge(h.bridge),
      customerId: 'cus_1',
      email: 'a@x.com',
    })
    expect(ids).toEqual([7, 8])
    expect(h.bridge.wizarr.findUserIdsByInvite).toHaveBeenCalledExactlyOnceWith('abc')
  })

  it('uses a linked address before the invite code', async () => {
    // A stated identity beats an inferred one, and beats an invite nobody used.
    //
    // This is the renewal half of the re-typed-address case: the paying customer
    // has no Wizarr record under its own email and holds an invite that was
    // never redeemed, so both existing lookups come back empty and the member's
    // access is never extended.
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'pays@x.com', inviteCode: 'abc' })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockImplementation(async (email) =>
      email === 'watches@x.com' ? [7, 8] : [],
    )
    h.bridge.wizarr.findUserIdsByInvite.mockResolvedValue([99])

    const ids = await resolveUserIds({
      bridge: asBridge(h.bridge),
      customerId: 'cus_1',
      email: 'pays@x.com',
    })

    expect(ids).toEqual([7, 8])
    expect(h.bridge.wizarr.findUserIdsByInvite).not.toHaveBeenCalled()
  })

  it("still prefers the member's own email over a link", async () => {
    h.bridge.store.upsertPending({ customerId: 'cus_1', email: 'pays@x.com', inviteCode: 'abc' })
    h.bridge.store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1])
    const ids = await resolveUserIds({
      bridge: asBridge(h.bridge),
      customerId: 'cus_1',
      email: 'pays@x.com',
    })
    expect(ids).toEqual([1])
    expect(h.bridge.wizarr.findUserIdsByEmail).toHaveBeenCalledExactlyOnceWith('pays@x.com')
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
