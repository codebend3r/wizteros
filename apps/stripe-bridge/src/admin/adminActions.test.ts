// Every admin action: history and notes, expiry, tier, reissue, cancel, tags
// and downloads, ban, and how each body is read.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { wizarrClient } from '@/clients/wizarr.js'
import { subscription, TEST_SETTINGS } from '@/test/fakes.js'
import {
  isMemberNotes,
  isResetTierResult,
  isLinkAddressResult,
  bodyOf,
  FIXTURE_LIBRARIES,
  type Harness,
  harness,
  stopServed,
  get,
  post,
  listMembers,
  getMember,
  getEvents,
  tiersOf,
  byEmail,
  memberOf,
  resetExpiry,
  reissue,
  cancel,
  ban,
  setTag,
  setDownloads,
  linkAddress,
} from '@/test/adminHarness.js'

afterEach(stopServed)

// --- history and notes ----------------------------------------------------------------------------

describe('history and notes', () => {
  it('appends admin actions to the member history', async () => {
    const h = await harness()
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    await reissue({ h, body: { email: 'A@X.com', tier: 'gold' } })
    await resetExpiry({ h, body: { email: 'a@x.com', days: 35 } })

    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events.map((e) => e.action)).toEqual(['Expiry reset', 'Invite issued']) // newest first
    expect(events[1]?.detail).toContain('gold tier')
    expect(events[0]?.detail).toBe('35 days')
  })

  it('roundtrips notes, case-insensitive on the email', async () => {
    const h = await harness()
    const notes = async () =>
      bodyOf({ answer: await get({ h, url: '/admin/notes?email=a@x.com' }), is: isMemberNotes })
    expect(await notes()).toEqual({ email: 'a@x.com', notes: '' })
    const out = bodyOf({
      answer: await post({
        h,
        url: '/admin/notes',
        payload: { email: 'A@X.com', notes: 'prefers 4K remuxes' },
      }),
      is: isMemberNotes,
    })
    expect(out).toEqual({ email: 'A@X.com', notes: 'prefers 4K remuxes' })
    expect((await notes()).notes).toBe('prefers 4K remuxes')
  })

  it('lists every member without an email', async () => {
    const h = await harness()
    h.bridge.store.recordEvent({
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    h.bridge.store.recordEvent({
      email: 'b@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    })

    expect((await getEvents({ h })).map((e) => e.email)).toEqual(['b@x.com', 'a@x.com'])
    expect((await getEvents({ h, email: 'a@x.com' })).map((e) => e.email)).toEqual(['a@x.com'])
  })
})

// --- expiry -----------------------------------------------------------------------------------------

describe('POST /admin/reset-expiry', () => {
  it('sets an absolute date on every record', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 12])
    const out = await resetExpiry({ h, body: { email: 'a@x.com', days: 15 } })
    expect(out.updated).toBe(2)
    expect(out.expires).not.toBeNull()
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(2)
  })

  it('clears with null days', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const out = await resetExpiry({ h, body: { email: 'a@x.com', days: null } })
    expect(out).toEqual({ updated: 1, expires: null })
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledWith({ userId: 9, expires: null })
  })

  it('reaches wizarr as an empty body for never-expire', async () => {
    // Route through the REAL wizarr client down to the wire.
    //
    // The unit tests above fake the client, which is exactly how a
    // serialization bug (a literal null Wizarr 400s) once slipped through —
    // this pins the actual HTTP body a never-expire produces.
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return init.method === 'GET'
        ? Response.json({ users: [{ id: 9, username: 'cj', email: 'a@x.com', server: 'Meleys' }] })
        : Response.json({ message: 'ok', new_expiry: null })
    }
    const h = await harness({
      adapt: (bridge) => ({
        ...bridge,
        wizarr: {
          ...bridge.wizarr,
          ...wizarrClient({ baseUrl: 'http://wizarr.test', apiKey: 'k', fetch }),
        },
      }),
    })
    const out = await resetExpiry({ h, body: { email: 'a@x.com' } })
    expect(out).toEqual({ updated: 1, expires: null })
    expect(calls[1]?.url).toBe('http://wizarr.test/api/users/9/update-expiry')
    const body = calls[1]?.init.body
    expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({})
  })

  it('accepts an absolute datetime', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const out = await resetExpiry({
      h,
      body: { email: 'a@x.com', expires_at: '2026-08-01T00:01:00Z' },
    })
    expect(out).toEqual({ updated: 1, expires: '2026-08-01T00:01:00+00:00' })
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledWith({
      userId: 9,
      expires: '2026-08-01T00:01:00+00:00',
    })
    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events[0]?.detail).toBe('to 2026-08-01T00:01:00+00:00')
  })

  it.each([
    ['2026-08-01T00:01:00.250Z', '2026-08-01T00:01:00.250000+00:00'],
    ['2026-08-01T05:31:00+05:30', '2026-08-01T00:01:00+00:00'],
    ['2026-08-01T00:01:00', '2026-08-01T00:01:00+00:00'],
  ])('writes expires_at %j as %j', async (expiresAt, expected) => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const out = await resetExpiry({ h, body: { email: 'a@x.com', expires_at: expiresAt } })
    expect(out).toEqual({ updated: 1, expires: expected })
  })

  it.each(['2026-02-30T00:00:00Z', '2026-08-01', '2026-08-01T00:01Z'])(
    'rejects expires_at %j',
    async (expiresAt) => {
      const h = await harness()
      h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
      const answer = await post({
        h,
        url: '/admin/reset-expiry',
        payload: { email: 'a@x.com', expires_at: expiresAt },
      })
      expect(answer.statusCode).toBe(400)
      expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    },
  )

  it('rejects a malformed expires_at', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const answer = await post({
      h,
      url: '/admin/reset-expiry',
      payload: {
        email: 'a@x.com',
        expires_at: 'next tuesday',
      },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'expires_at is not an ISO datetime' })
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('404s when there are no records', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    const answer = await post({
      h,
      url: '/admin/reset-expiry',
      payload: { email: 'ghost@x.com', days: 15 },
    })
    expect(answer.statusCode).toBe(404)
    expect(answer.json()).toEqual({ detail: 'no member for that email' })
  })

  it('kicks a snapshot refresh', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1])
    const refreshed = vi.spyOn(h.snapshot, 'refreshAsync').mockImplementation(() => {})
    await resetExpiry({ h, body: { email: 'a@x.com', days: 30 } })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })
})

// --- tier ---------------------------------------------------------------------------------------------

describe('POST /admin/reset-tier', () => {
  const resetTier = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
    bodyOf({
      answer: await post({ h, url: '/admin/reset-tier', payload: body }),
      is: isResetTierResult,
    })

  it('hard-sets the record and logs', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const out = await resetTier({ h, body: { email: 'A@X.com', tier: 'bronze' } })
    expect(out).toEqual({ email: 'A@X.com', tier: 'bronze' })
    expect(tiersOf(h)).toEqual(new Map([['a@x.com', 'bronze']]))
    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events[0]?.action).toBe('Tier reset')
    expect(events[0]?.detail).toBe('hard reset to bronze')
    // record-only: no invite, no disable, no Wizarr call at all
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it.each(['bronze', 'silver', 'gold', 'youth'])('hard-sets each tier: %s', async (tier) => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const out = await resetTier({ h, body: { email: 'a@x.com', tier } })
    expect(out).toEqual({ email: 'a@x.com', tier })
    expect(tiersOf(h)).toEqual(new Map([['a@x.com', tier]]))
    expect((await getEvents({ h, email: 'a@x.com' }))[0]?.detail).toBe(`hard reset to ${tier}`)
  })

  it('rejects an unknown tier', async () => {
    const h = await harness()
    const answer = await post({
      h,
      url: '/admin/reset-tier',
      payload: { email: 'a@x.com', tier: 'platinum' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'unknown tier "platinum"' })
    expect(tiersOf(h)).toEqual(new Map())
  })
})

// --- reissue ----------------------------------------------------------------------------------------------

describe('POST /admin/reissue-invite', () => {
  it('keeps covered records enabled', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    // every record sits on a server the new scope covers -> access survives
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Meleys' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled() // redeeming re-scopes in place
    // private 99. and the retired Vermithor mirror excluded -> ids 17 + 20
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20],
      allowDownloads: false,
    })
    expect(out.disabled).toBe(0)
    expect(out.code).toBe('xyz')
    expect(out.url).toBe('http://inv.test/j/xyz') // public URL, not the LAN one
    expect(out.tier).toBe('silver')
  })

  it('disables all records when a server is uncovered', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    // the retired servers are in no tier's scope and there is no per-server
    // unshare, so the reissue falls back to disable-first
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 9, server: 'Meleys' },
      { id: 12, server: 'Caraxes' },
    ])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledTimes(2) // all records dropped, not just Caraxes's
    // invite must be created BEFORE any disable, so a create failure can't lock
    // the member out with no link to re-redeem
    const [created] = h.bridge.wizarr.createInvite.mock.invocationCallOrder
    const [firstDisable] = h.bridge.wizarr.disableUser.mock.invocationCallOrder
    expect(created).toBeLessThan(firstDisable ?? 0)
    expect(out.disabled).toBe(2)
  })

  it('emails the link', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledTimes(1)
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/xyz',
    })
    expect(out.emailed).toBe(true)
  })

  it('survives an email failure', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Caraxes' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    h.bridge.mailer.sendInvite.mockRejectedValue(new Error('smtp down'))
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    // the reissue itself completed; the admin still gets the link to send manually
    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledTimes(1) // Caraxes retired -> disable path
    expect(out.emailed).toBe(false)
    expect(out.url).toBe('http://inv.test/j/xyz')
  })

  it('keeps the member visible as pending', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Meleys' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({
      code: 'NEW1',
      url: 'http://wizarr-lan/j/NEW1',
    })
    await reissue({ h, body: { email: 'Code@X.com', tier: 'gold' } })

    // even if Wizarr later drops the records, the store row keeps them listed
    h.bridge.wizarr.listUsers.mockResolvedValue([])
    await h.snapshot.settled()
    await h.snapshot.refresh()
    const members = await listMembers(h)
    expect(byEmail(members).has('code@x.com')).toBe(true) // still listed while the invite is pending
    const pending = memberOf({ members, email: 'code@x.com' })
    expect(pending.tier).toBe('gold')
    expect(pending.subscribed).toBe(false)
    expect(pending.invited_at).not.toBeNull() // grace clock started
  })

  it('fails closed without a public base', async () => {
    const h = await harness({ settings: { ...TEST_SETTINGS, publicInviteBase: '' } })
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Caraxes' }])
    const answer = await post({
      h,
      url: '/admin/reissue-invite',
      payload: { email: 'a@x.com', tier: 'silver' },
    })
    expect(answer.statusCode).toBe(500)
    expect(answer.json()).toEqual({ detail: 'PUBLIC_INVITE_BASE not configured' })
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled() // fails before any destructive action
  })

  it('applies the downloads override', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Vermithor' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    h.bridge.store.setMemberDownloads({ email: 'a@x.com', allow: true })

    await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    // silver's tier default is allowDownloads false; the override wins
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ allowDownloads: true }),
    )
  })

  it('kicks a snapshot refresh', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Vermithor' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const refreshed = vi.spyOn(h.snapshot, 'refreshAsync').mockImplementation(() => {})
    await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })

  it('refuses a banned member', async () => {
    const h = await harness()
    h.bridge.store.setMemberTag({ email: 'a@x.com', tag: 'banned' })
    const answer = await post({
      h,
      url: '/admin/reissue-invite',
      payload: { email: 'A@X.com', tier: 'gold' },
    })
    expect(answer.statusCode).toBe(409)
    expect(answer.json().detail).toContain('banned')
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
  })
})

// --- stripe ---------------------------------------------------------------------------------------------------

describe('POST /admin/cancel-subscription', () => {
  it('flags the subscriptions of the stored customer', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_1' })])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    )

    const result = await cancel({ h, email: 'A@X.com' })

    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledWith('cus_9')
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1')
    expect(h.bridge.stripe.customerIdsForEmail).not.toHaveBeenCalled() // mapping wins over email lookup
    expect(result.canceled).toBe(1)
    expect(result.cancel_at?.startsWith('2026-') ?? false).toBe(true)
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Cancellation scheduled')
    expect(events[0]?.detail).toContain('by admin')
  })

  it('falls back to a stripe email lookup', async () => {
    const h = await harness()
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_2' })])
    h.bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_via_email'])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_2', cancel_at: 1790000000, cancel_at_period_end: true }),
    )

    const result = await cancel({ h, email: 'nomap@x.com' })

    expect(h.bridge.stripe.customerIdsForEmail).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.customerIdsForEmail).toHaveBeenCalledWith('nomap@x.com')
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledWith('cus_via_email')
    expect(result.canceled).toBe(1)
  })

  it('404s without a customer or a subscription', async () => {
    const h = await harness()
    const noCustomer = await post({
      h,
      url: '/admin/cancel-subscription',
      payload: { email: 'ghost@x.com' },
    })
    expect(noCustomer.statusCode).toBe(404)
    expect(noCustomer.json()).toEqual({ detail: 'no stripe customer for that email' })

    h.bridge.store.upsertPending({
      customerId: 'cus_idle',
      email: 'idle@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const noSub = await post({
      h,
      url: '/admin/cancel-subscription',
      payload: { email: 'idle@x.com' },
    })
    expect(noSub.statusCode).toBe(404)
    expect(noSub.json()).toEqual({ detail: 'no active subscription for that email' })
  })

  it('is idempotent for already-flagged subscriptions', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    ])

    const result = await cancel({ h, email: 'a@x.com' })

    expect(h.bridge.stripe.cancelAtPeriodEnd).not.toHaveBeenCalled()
    expect(result.canceled).toBe(0)
    expect(result.cancel_at?.startsWith('2026-') ?? false).toBe(true)
    expect(h.bridge.store.eventsForEmail({ email: 'a@x.com' })).toEqual([]) // no duplicate history row
  })
})

// --- tags and downloads ------------------------------------------------------------------------------------------

describe('tags and downloads', () => {
  it('roundtrips a tag through the member payloads', async () => {
    const h = await harness()
    await setTag({ h, body: { email: 'A@X.com', tag: 'vip' } })

    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('vip')
    const members = await listMembers(h)
    expect(memberOf({ members, email: 'a@x.com' }).tag).toBe('vip')
    expect(memberOf({ members, email: 'nora@x.com' }).tag).toBeNull()

    await setTag({ h, body: { email: 'a@x.com', tag: null } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBeNull()

    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events.map((e) => e.detail)).toEqual(['tag cleared', 'tagged VIP'])
  })

  it('rejects unknown tags', async () => {
    const h = await harness()
    const answer = await post({
      h,
      url: '/admin/set-tag',
      payload: { email: 'a@x.com', tag: 'whale' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'unknown tag "whale"' })
  })

  it('overrides the tier default in member payloads with the downloads toggle', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    }) // gold -> downloads true

    expect(await setDownloads({ h, body: { email: 'A@X.com', allow: false } })).toEqual({
      email: 'A@X.com',
      downloads: false,
    })

    expect((await getMember({ h, email: 'a@x.com' })).downloads).toBe(false) // override beats gold's true
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).downloads).toBe(false)
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Downloads toggled')
    expect(events[0]?.detail).toBe('turned off by admin')

    await setDownloads({ h, body: { email: 'a@x.com', allow: true } })
    expect((await getMember({ h, email: 'a@x.com' })).downloads).toBe(true)
  })

  it('accepts banned, and clearing it unbans', async () => {
    const h = await harness()
    await setTag({ h, body: { email: 'a@x.com', tag: 'banned' } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('banned')
    await setTag({ h, body: { email: 'a@x.com', tag: null } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBeNull()
  })
})

// --- ban ------------------------------------------------------------------------------------------------------------

describe('POST /admin/ban', () => {
  it('tags the member and cancels their billing', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_1' })])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    )
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1, 2])

    const result = await ban({ h, email: 'A@X.com' })

    expect(result).toEqual({
      email: 'A@X.com',
      disabled: 2,
      canceled: 1,
      cancel_at: '2026-09-21T14:13:20+00:00',
    })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('banned')
    expect(h.bridge.wizarr.disableUser.mock.calls).toEqual([[1], [2]])
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1')
    const events = h.bridge.store.eventsForEmail({ email: 'a@x.com' })
    expect(events[0]?.action).toBe('Banned')
    expect(events[0]?.detail).toContain('2 server record(s) disabled')
    expect(events[0]?.detail).toContain('billing stops 2026-09-21')
  })

  it('works for a member with nothing to revoke', async () => {
    // Someone already gone from Wizarr and Stripe can still be marked, so the
    // next checkout or re-invite under that address is refused.
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])

    const result = await ban({ h, email: 'gone@x.com' })

    expect(result).toEqual({ email: 'gone@x.com', disabled: 0, canceled: 0, cancel_at: null })
    expect(h.bridge.store.getMemberTag({ email: 'gone@x.com' })).toBe('banned')
    expect(h.bridge.store.eventsForEmail({ email: 'gone@x.com' })[0]?.detail).toBe(
      'no server records to disable; no subscription to cancel',
    )
  })

  it('still lands when stripe is down', async () => {
    const h = await harness()
    h.bridge.stripe.subscriptionsFor.mockRejectedValue(new Error('stripe is down'))
    h.bridge.stripe.customerIdsForEmail.mockRejectedValue(new Error('stripe is down'))
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([7])

    const result = await ban({ h, email: 'a@x.com' })

    expect(result.disabled).toBe(1)
    expect(result.canceled).toBe(0)
    expect(h.bridge.store.getMemberTag({ email: 'a@x.com' })).toBe('banned')
    expect(h.bridge.store.eventsForEmail({ email: 'a@x.com' })[0]?.detail).toContain(
      'could not reach Stripe',
    )
  })
})

// --- request bodies ---------------------------------------------------------------------------------------------------
//
// Bodies are typed the way the portal sends them; anything else is a 422.

describe('request bodies', () => {
  it.each([15, 15.0, -3])('reads days %j', async (days) => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await resetExpiry({ h, body: { email: 'a@x.com', days } })
    expect((await getEvents({ h, email: 'a@x.com' }))[0]?.detail).toBe(`${days} days`)
  })

  it.each([1.5, '15', ' 15 ', '1_5', '+15', true, '', 'abc', [], {}])(
    'refuses days %j with a 422',
    async (days) => {
      const h = await harness()
      h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
      const answer = await post({
        h,
        url: '/admin/reset-expiry',
        payload: { email: 'a@x.com', days },
      })
      expect(answer.statusCode).toBe(422)
      expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    },
  )

  it.each([true, false])('reads allow %j', async (allow) => {
    const h = await harness()
    expect((await setDownloads({ h, body: { email: 'a@x.com', allow } })).downloads).toBe(allow)
  })

  it.each([1, 0, 'yes', 'true', '', null])('refuses allow %j with a 422', async (allow) => {
    const h = await harness()
    expect(
      (await post({ h, url: '/admin/set-downloads', payload: { email: 'a@x.com', allow } }))
        .statusCode,
    ).toBe(422)
  })

  it.each([1, true, null])('refuses a non-string email %j with a 422', async (email) => {
    const h = await harness()
    expect(
      (await post({ h, url: '/admin/notes', payload: { email, notes: 'n' } })).statusCode,
    ).toBe(422)
  })

  it('refuses a missing field with a 422 in the detail shape', async () => {
    const h = await harness()
    const answer = await post({ h, url: '/admin/notes', payload: { email: 'a@x.com' } })
    expect(answer.statusCode).toBe(422)
    expect(Array.isArray(answer.json().detail)).toBe(true)
  })

  it('ignores extra fields, and reads a left-out optional as null', async () => {
    const h = await harness()
    expect(await setTag({ h, body: { email: 'a@x.com', extra: 1 } })).toEqual({
      email: 'a@x.com',
      tag: null,
    })
  })

  it('treats an empty plex_email as an unlink', async () => {
    const h = await harness()
    const answer = await linkAddress({ h, body: { stripe_email: ' Pays@x.com ', plex_email: '' } })
    expect(bodyOf({ answer, is: isLinkAddressResult })).toEqual({
      stripe_email: 'pays@x.com',
      plex_email: null,
    })
    expect(h.bridge.store.eventsForEmail({ email: 'pays@x.com' })[0]?.action).toBe(
      'Address unlinked',
    )
  })

  it('refuses a blank stripe_email', async () => {
    const h = await harness()
    const answer = await linkAddress({ h, body: { stripe_email: '  ' } })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'stripe_email is required' })
  })
})
