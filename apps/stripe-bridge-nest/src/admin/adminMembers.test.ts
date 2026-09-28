// The members list and the member page: what the portal is served for each
// member, and how a Stripe address and a Plex address become one person.

import { afterEach, describe, expect, it } from 'vitest'
import { PlexUnavailable } from '@/clients/plex.js'
import {
  isPlexAccess,
  isLinkAddressResult,
  bodyOf,
  GOLD_LIBRARIES,
  PLEX_SHARES,
  harness,
  stopServed,
  get,
  listMembers,
  getMember,
  byEmail,
  memberOf,
  linkAddress,
} from '@/test/adminHarness.js'

afterEach(stopServed)

// --- the members list ---------------------------------------------------------------------

describe('GET /admin/members', () => {
  it('dedupes and joins the tier', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const members = await listMembers(h)

    const cj = memberOf({ members, email: 'a@x.com' })
    expect(cj.member).toBe('cj')
    expect([...cj.servers].toSorted()).toEqual(['Meleys', 'Vhagar']) // 2 records -> 1 person
    expect(cj.expires).toBe('2026-09-10T00:00:00+00:00') // latest wins
    expect(cj.subscribed).toBe(true)
    expect(cj.tier).toBe('gold')
    expect(cj.downloads).toBe(true) // derived from tier
    // per-server access derives from tier rules: only the share server
    // grants anything, and 90. private is never shown
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)

    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.subscribed).toBe(false)
    expect(nora.tier).toBe('unknown')
    expect(nora.downloads).toBeNull()
    expect(nora.libraries).toEqual({ Syrax: [] }) // unknown tier grants nothing
  })

  it('unions the live plex share', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue(PLEX_SHARES)
    const members = await listMembers(h)

    const cj = memberOf({ members, email: 'a@x.com' })
    // a server only plex.tv knows about is unioned in with Wizarr's records
    expect(cj.servers).toEqual(['Caraxes', 'Meleys', 'Vhagar'])
    // plex is ground truth where it has an answer...
    expect(cj.libraries?.Meleys).toEqual(['01. Movies', '05. TV Shows'])
    expect(cj.libraries?.Caraxes).toEqual(['09. Basketball'])
    // ...and gold reaches Vhagar too, so the tier derives its library there
    expect(cj.libraries?.Vhagar).toEqual(['03. 4K Movies'])

    // unknown tier derives no libraries, so plex is the only real answer here
    expect(memberOf({ members, email: 'nora@x.com' }).libraries).toEqual({ Syrax: ['02. Anime'] })
  })

  it('gives plex-only servers to a member who never joined', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue({
      'max@x.com': {
        Meleys: { all_libraries: false, allow_sync: false, libraries: ['03. Family Movies'] },
      },
    })
    const mx = memberOf({ members: await listMembers(h), email: 'max@x.com' })
    expect(mx.servers).toEqual(['Meleys']) // legacy share, no Wizarr record
    expect(mx.libraries).toEqual({ Meleys: ['03. Family Movies'] })
  })

  it('falls back to tier access without a plex token', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.servers).toEqual(['Meleys', 'Vhagar'])
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)
    expect(h.bridge.plex.sharedAccessAll).not.toHaveBeenCalled()
  })

  it('survives a plex.tv failure', async () => {
    // plex.tv is an enrichment, never a dependency: the table must still load.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockRejectedValue(new PlexUnavailable('plex.tv down'))
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.servers).toEqual(['Meleys', 'Vhagar'])
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)
  })

  it('reads subscribed off the flag, not the expiry', async () => {
    // a@x.com carries a future Wizarr expiry in USERS, but only an admin-issued
    // invite (no confirmed payment). subscribed must be false despite the expiry
    // — this is what lets a member read "Invited" while a 14-day clock counts down.
    const h = await harness()
    h.bridge.store.upsertPendingByEmail({ email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.expires).toBe('2026-09-10T00:00:00+00:00') // future expiry present
    expect(cj.subscribed).toBe(false) // but no payment on record
    expect(cj.invited_at).not.toBeNull() // admin invite stamped it
  })

  it('includes subscribers not yet joined', async () => {
    const h = await harness()
    // a Stripe subscriber the bridge knows who never redeemed a Wizarr invite
    h.bridge.store.upsertPending({
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    const members = await listMembers(h)
    expect(byEmail(members).has('max@x.com')).toBe(true) // shown despite having no Wizarr record
    const mx = memberOf({ members, email: 'max@x.com' })
    expect(mx.tier).toBe('youth')
    expect(mx.downloads).toBe(true) // derived from youth
    expect(mx.subscribed).toBe(true) // checkout completed -> confirmed payment
    // They have not joined yet, so they hold nothing: servers and libraries are
    // what a member can actually watch, and inventing them from the tier is how
    // a locked-out member reads as fully served on /manage. What redeeming
    // would grant them is carried separately, in entitled.
    expect(mx.servers).toEqual([])
    expect(mx.libraries).toEqual({})
    expect(mx.entitled).toEqual({ Meleys: ['03. Family Movies', '14. Kid Shows'] })
    expect(mx.invited_at).not.toBeNull() // upsert stamped the grace clock
  })

  it("gives a pending subscriber their tier's libraries as entitlement", async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_y',
      email: 'youth@x.com',
      inviteCode: 'INV2',
      tier: 'youth',
    })
    const members = await listMembers(h)
    // entitled is the tier-derived set; libraries stays empty until they join
    expect(memberOf({ members, email: 'gold@x.com' }).entitled).toEqual(GOLD_LIBRARIES)
    expect(memberOf({ members, email: 'youth@x.com' }).entitled).toEqual({
      Meleys: ['03. Family Movies', '14. Kid Shows'],
    })
    expect(memberOf({ members, email: 'gold@x.com' }).libraries).toEqual({})
  })

  it('shows nothing for a pending subscriber with an unknown tier', async () => {
    // No tier recorded means no basis to claim any access.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_n',
      email: 'notier@x.com',
      inviteCode: 'INV1',
      tier: null,
    })
    const mx = memberOf({ members: await listMembers(h), email: 'notier@x.com' })
    expect(mx.tier).toBe('unknown')
    expect(mx.servers).toEqual([])
    expect(mx.libraries).toEqual({})
  })

  it('never shows a pending subscriber a private library', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const mx = memberOf({ members: await listMembers(h), email: 'gold@x.com' })
    const names = Object.values(mx.libraries ?? {}).flat()
    expect(names).not.toContain('90. Private')
  })

  it('never pays for a stripe lookup', async () => {
    // The list is one row per member; a per-row Stripe search would crawl.
    const h = await harness()
    h.bridge.store.upsertPendingByEmail({ email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    await listMembers(h)
    expect(h.bridge.stripe.searchCustomerId).not.toHaveBeenCalled()
  })

  it('serves the warm snapshot', async () => {
    const h = await harness()
    const first = await listMembers(h)
    // Upstream changes but the snapshot keeps serving until a refresh runs.
    h.bridge.wizarr.listUsers.mockResolvedValue([])
    expect(await listMembers(h)).toEqual(first)
    expect(h.bridge.wizarr.listUsers).toHaveBeenCalledTimes(1)
    await h.snapshot.refresh()
    expect(await listMembers(h)).toEqual([])
  })

  it('keeps overrides live on a cached snapshot', async () => {
    const h = await harness()
    await listMembers(h)
    h.bridge.store.setMemberTag({ email: 'a@x.com', tag: 'vip' })
    // DB join fresh despite cached upstream
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).tag).toBe('vip')
  })

  it('carries a pure tier entitlement map', async () => {
    // `libraries` is keyed by the servers a member actually holds records on, so
    // it cannot answer "what does this tier grant". `entitled` is the tier rules
    // alone — the baseline the member page compares the live plex.tv share to.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.entitled).toEqual(GOLD_LIBRARIES)
    // gold entitles Vhagar now, and the member holds a record there
    expect(cj.servers).toContain('Vhagar')
    expect(Object.keys(cj.entitled ?? {})).toContain('Vhagar')
  })

  it('makes entitlement follow the tier, not the records', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'youth',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.entitled).toEqual({ Meleys: ['03. Family Movies', '14. Kid Shows'] })
  })

  it('entitles an unknown tier to nothing', async () => {
    const h = await harness()
    const nora = memberOf({ members: await listMembers(h), email: 'nora@x.com' })
    expect(nora.tier).toBe('unknown')
    expect(nora.entitled).toEqual({})
  })

  it('keeps the entitlement through the plex union', async () => {
    // withPlexAccess rewrites `libraries` with what plex.tv reports; the
    // entitlement baseline must NOT be overwritten or the comparison collapses.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue(PLEX_SHARES)
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.libraries?.Meleys).toEqual(['01. Movies', '05. TV Shows']) // plex wins here
    expect(cj.entitled).toEqual(GOLD_LIBRARIES) // tier stands
  })

  it('does not show the pending entitlement as what they hold', async () => {
    // The two must not be conflated: entitled is what the tier grants on
    // redeeming, libraries is what they can watch right now.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const mx = memberOf({ members: await listMembers(h), email: 'gold@x.com' })
    expect(mx.entitled).toEqual(GOLD_LIBRARIES)
    expect(mx.libraries).toEqual({})
  })

  it('answers every field of a member, null rather than missing', async () => {
    // The portal tolerates some fields missing for an older bridge; this one
    // always sends every key.
    const h = await harness()
    const [first] = await listMembers(h)
    expect(Object.keys(first ?? {}).toSorted()).toEqual(
      [
        'member',
        'email',
        'tier',
        'downloads',
        'expires',
        'servers',
        'libraries',
        'entitled',
        'subscribed',
        'payment_state',
        'invited_at',
        'customer_id',
        'stripe_email',
        'tag',
      ].toSorted(),
    )
  })
})

// --- one address paying for another ---------------------------------------------------------

describe('the stripe address and the plex address', () => {
  it('reads a member paying under another address as one row, not two', async () => {
    // The Stripe email and the Plex email are two addresses for one person.
    //
    // Someone can check out with one address and create their Plex account with
    // another. Keyed on email alone that is two members: one "subscribed" row
    // holding no access and one Plex row that never paid. The invite is what ties
    // them together, because whoever redeemed it is the person who paid for it.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    // redeemed by nora@x.com
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 3>' },
    ])
    h.snapshot.clear()

    const members = await listMembers(h)
    // one row, under the Plex address they actually watch with
    expect(byEmail(members).has('nora@x.com')).toBe(true)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false)
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.stripe_email).toBe('stripe-only@x.com')
    expect(nora.tier).toBe('gold') // the tier they pay for
    expect(nora.subscribed).toBe(true) // the payment follows the person
    expect(nora.customer_id).toBe('cus_1')
  })

  it('carries no separate stripe email for matching addresses', async () => {
    // The common case must not render the same string twice.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 1>' },
    ])
    h.snapshot.clear()
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).stripe_email).toBeNull()
  })

  it('links nothing through an unredeemed invite', async () => {
    // Until someone redeems it, the bridge has no basis to merge two rows.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    h.snapshot.clear()
    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(true) // still stands on its own
    expect(memberOf({ members, email: 'stripe-only@x.com' }).stripe_email).toBeNull()
    expect(memberOf({ members, email: 'nora@x.com' }).subscribed).toBe(false)
  })

  it('collapses through a linked address a pair no invite can join', async () => {
    // The Jimmy case: two customers, one person, and an invite never redeemed.
    //
    // Someone whose card declines and who re-subscribes under a re-typed address
    // already holds access, so the new checkout's invite sits unredeemed forever
    // and `used_by` can never tie the two together. The admin's link is the only
    // thing that can, and it has to produce exactly what the invite join would.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    h.bridge.store.setMemberLink({ stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false) // no longer its own row
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.stripe_email).toBe('stripe-only@x.com')
    expect(nora.tier).toBe('gold')
    expect(nora.subscribed).toBe(true)
    expect(nora.customer_id).toBe('cus_new')
  })

  it("lets a link outrank a customer row at the member's own address", async () => {
    // The dead address is usually still a customer; the live one must win.
    //
    // A member who re-subscribed has two Stripe customers: the failing one at
    // their own address and the paying one at the other. Reading billing from
    // the row that merely matches on email would show the abandoned subscription
    // and its tier while the money arrives somewhere else.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_dead',
      email: 'nora@x.com',
      inviteCode: 'INVOLD',
      tier: 'bronze',
    })
    h.bridge.store.upsertPending({
      customerId: 'cus_live',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    h.bridge.store.setMemberLink({ stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false)
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.customer_id).toBe('cus_live') // the one actually paying
    expect(nora.tier).toBe('gold')
    expect(nora.stripe_email).toBe('stripe-only@x.com')
  })

  it('puts an unlinked address back on its own', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_new',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    h.bridge.store.setMemberLink({ stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    h.bridge.store.setMemberLink({ stripeEmail: 'stripe-only@x.com', plexEmail: null })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(true)
    expect(memberOf({ members, email: 'nora@x.com' }).stripe_email).toBeNull()
  })

  it('resolves a plain username in used_by too', async () => {
    // Wizarr returns a repr today; a real username must keep working.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: 'nora' }])
    h.snapshot.clear()
    expect(memberOf({ members: await listMembers(h), email: 'nora@x.com' }).stripe_email).toBe(
      'stripe-only@x.com',
    )
  })

  it('shows the stripe address on the member page', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 3>' },
    ])
    const m = await getMember({ h, email: 'nora@x.com' })
    expect(m.stripe_email).toBe('stripe-only@x.com')
    expect(m.customer_id).toBe('cus_1')
  })

  it('keeps the member page up when wizarr refuses the invitation list', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockRejectedValue(new Error('wizarr is down'))
    const m = await getMember({ h, email: 'nora@x.com' })
    expect(m.stripe_email).toBeNull() // linkage lost, page still renders
  })
})

describe('POST /admin/link-address', () => {
  it('refuses a self link', async () => {
    const h = await harness()
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'a@x.com', plex_email: 'A@x.com' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'an address cannot link to itself' })
  })

  it('refuses a chain', async () => {
    const h = await harness()
    h.bridge.store.setMemberLink({ stripeEmail: 'b@x.com', plexEmail: 'c@x.com' })
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'a@x.com', plex_email: 'b@x.com' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'b@x.com already pays under c@x.com; unlink it first' })
  })

  it('records both sides', async () => {
    const h = await harness()
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'Pays@x.com', plex_email: 'Watches@x.com' },
    })
    expect(bodyOf({ answer, is: isLinkAddressResult })).toEqual({
      stripe_email: 'pays@x.com',
      plex_email: 'watches@x.com',
    })
    expect(h.bridge.store.allMemberLinks()).toEqual(new Map([['pays@x.com', 'watches@x.com']]))
    expect(h.bridge.store.eventsForEmail({ email: 'watches@x.com' }).map((e) => e.action)).toEqual([
      'Address linked',
    ])
    expect(h.bridge.store.eventsForEmail({ email: 'pays@x.com' }).map((e) => e.action)).toEqual([
      'Address linked',
    ])
  })
})

// --- the member page ----------------------------------------------------------------------------

describe('GET /admin/member', () => {
  it('finds a member, and 404s a missing one', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const found = await getMember({ h, email: 'a@x.com' })
    expect(found.member).toBe('cj')
    expect(found.libraries).toEqual(GOLD_LIBRARIES)
    const missing = await get({ h, url: '/admin/member?email=ghost@x.com' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ detail: 'no member for that email' })
  })

  it("shows a pending subscriber their tier's libraries", async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const m = await getMember({ h, email: 'gold@x.com' })
    // entitled drives the member page's Servers section; holding nothing yet is
    // reported as holding nothing.
    expect(m.entitled).toEqual(GOLD_LIBRARIES)
    expect(m.servers).toEqual([])
    expect(m.libraries).toEqual({})
  })

  it('falls back to the subscriber', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    const m = await getMember({ h, email: 'max@x.com' })
    expect(m.email.toLowerCase()).toBe('max@x.com')
    expect(m.tier).toBe('youth')
    expect(m.subscribed).toBe(true) // checkout completed -> confirmed payment
    // in neither Wizarr nor customer_map
    expect((await get({ h, url: '/admin/member?email=nobody@nowhere.com' })).statusCode).toBe(404)
  })

  it('carries the stripe customer id on both member payloads', async () => {
    // Real cus_ ids surface on both endpoints; admin placeholders never leak.
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.store.upsertPendingByEmail({ email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })

    const members = await listMembers(h)
    expect(memberOf({ members, email: 'a@x.com' }).customer_id).toBe('cus_1')
    expect(memberOf({ members, email: 'max@x.com' }).customer_id).toBeNull() // admin:<email> placeholder
    expect(memberOf({ members, email: 'nora@x.com' }).customer_id).toBeNull() // no customer_map row at all

    expect((await getMember({ h, email: 'a@x.com' })).customer_id).toBe('cus_1') // joined member
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBeNull() // nothing at Stripe either
  })

  it('finds a stripe customer the store never recorded', async () => {
    // An admin-invited member still links to Stripe when a customer exists there.
    //
    // customer_map only holds a real cus_ for members the bridge put there via a
    // checkout; everyone else carries an "admin:<email>" placeholder. Concluding
    // from that placeholder that they have no Stripe record is how a paying
    // member's billing history became unreachable from their own page.
    const h = await harness()
    h.bridge.store.upsertPendingByEmail({ email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    h.bridge.stripe.searchCustomerId.mockResolvedValue('cus_real')
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBe('cus_real')
    expect(h.bridge.stripe.searchCustomerId).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.searchCustomerId).toHaveBeenCalledWith('max@x.com')
  })

  it('survives a stripe lookup failure', async () => {
    const h = await harness()
    h.bridge.store.upsertPendingByEmail({ email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    h.bridge.stripe.searchCustomerId.mockRejectedValue(new Error('stripe is down'))
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBeNull() // page still renders
  })

  it('carries the entitlement too', async () => {
    const h = await harness()
    h.bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    const m = await getMember({ h, email: 'a@x.com' })
    expect(m.entitled).toEqual({ Meleys: ['01. Movies', '03. Family Movies', '14. Kid Shows'] })
  })

  it('needs an email, as a 422', async () => {
    const h = await harness()
    const answer = await get({ h, url: '/admin/member' })
    expect(answer.statusCode).toBe(422)
    expect(Array.isArray(answer.json().detail)).toBe(true)
  })
})

// --- plex.tv ------------------------------------------------------------------------------------

describe('GET /admin/plex-access', () => {
  it('requires a token', async () => {
    const h = await harness()
    const answer = await get({ h, url: '/admin/plex-access?email=a@x.com' })
    expect(answer.statusCode).toBe(503)
    expect(answer.json()).toEqual({ detail: 'PLEX_TOKEN not configured' })
  })

  it('returns per-server shares', async () => {
    const h = await harness()
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessForEmail.mockResolvedValue({
      Meleys: { all_libraries: true, allow_sync: true, libraries: ['01. Movies'] },
    })
    const out = bodyOf({
      answer: await get({ h, url: '/admin/plex-access?email=a@x.com' }),
      is: isPlexAccess,
    })
    expect(out.email).toBe('a@x.com')
    expect(out.servers.Meleys?.all_libraries).toBe(true)
  })

  it('maps a plex.tv failure to 502', async () => {
    const h = await harness()
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessForEmail.mockRejectedValue(new PlexUnavailable('plex.tv down'))
    const answer = await get({ h, url: '/admin/plex-access?email=a@x.com' })
    expect(answer.statusCode).toBe(502)
    expect(answer.json()).toEqual({ detail: 'plex.tv lookup failed' })
  })
})
