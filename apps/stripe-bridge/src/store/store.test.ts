import { dirname, join } from 'node:path'
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type BridgeStore, openStore } from '@/store/openStore.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { withSqlite } from '@wizteros/server-common'

/** A fresh, initialised store in its own temp directory. */
const freshStore = (): BridgeStore => {
  const store = openStore(tempDbPath())
  store.init()
  return store
}

/** Lowercased email -> recorded tier, one entry per email as the members list reads it. */
const tiersOf = (store: BridgeStore): ReadonlyMap<string, string | null> =>
  new Map([...store.allCustomerRows()].map(([email, row]) => [email, row.tier]))

/** Run raw SQL against a file, to lay down a table as an older release left it. */
const execute = ({ path, sql }: { path: string; sql: readonly string[] }): void =>
  withSqlite({ path, work: (database) => sql.forEach((statement) => database.exec(statement)) })

describe('store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    removeTempDirs()
  })

  it('upserts and gets', () => {
    const store = freshStore()

    expect(store.getMapping({ customerId: 'cus_1' })).toBeNull()

    store.upsertPending({ customerId: 'cus_1', email: 'a@example.com', inviteCode: 'abc123' })
    expect(store.getMapping({ customerId: 'cus_1' })).toEqual({
      stripe_customer_id: 'cus_1',
      email: 'a@example.com',
      invite_code: 'abc123',
    })

    // upsert again updates email, keeps row unique
    store.upsertPending({ customerId: 'cus_1', email: 'b@example.com', inviteCode: 'abc123' })
    expect(store.getMapping({ customerId: 'cus_1' })?.email).toBe('b@example.com')

    // a new checkout re-points the mapping at the fresh invite code
    store.upsertPending({ customerId: 'cus_1', email: 'b@example.com', inviteCode: 'xyz789' })
    expect(store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('xyz789')
  })

  it('dedups mark event processed', () => {
    const store = freshStore()

    expect(store.markEventProcessed({ eventId: 'evt_1' })).toBe(true)
    expect(store.markEventProcessed({ eventId: 'evt_1' })).toBe(false)
  })

  it('reports whether an event is processed', () => {
    const store = freshStore()

    expect(store.isEventProcessed({ eventId: 'evt_1' })).toBe(false)
    store.markEventProcessed({ eventId: 'evt_1' })
    expect(store.isEventProcessed({ eventId: 'evt_1' })).toBe(true)
  })

  it('persists the tier and looks it up by email', () => {
    const store = freshStore()

    store.upsertPending({
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.upsertPending({ customerId: 'cus_2', email: 'b@x.com', inviteCode: 'def' }) // tier defaults to null

    // lookup is lowercased; a row with no tier reads as null
    expect(tiersOf(store)).toEqual(
      new Map([
        ['a@x.com', 'gold'],
        ['b@x.com', null],
      ]),
    )
    // existing mapping shape is unchanged (no tier key)
    expect(store.getMapping({ customerId: 'cus_1' })).toEqual({
      stripe_customer_id: 'cus_1',
      email: 'A@X.com',
      invite_code: 'abc',
    })
  })

  it('initDb adds the tier column to a legacy table', () => {
    const db = tempDbPath()
    // simulate a pre-tier prod DB
    execute({
      path: db,
      sql: [
        'CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)',
      ],
    })
    const store = openStore(db)
    store.init() // must ALTER, not crash
    store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    expect(tiersOf(store)).toEqual(new Map([['a@x.com', 'silver']]))
  })

  it('upsertPendingByEmail inserts a placeholder row', () => {
    const store = freshStore()
    store.upsertPendingByEmail({ email: 'Code@X.com', inviteCode: 'INV1', tier: 'gold' })
    expect(tiersOf(store)).toEqual(new Map([['code@x.com', 'gold']]))
  })

  it('upsertPendingByEmail re-points an existing Stripe row', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    store.upsertPendingByEmail({ email: 'a@x.com', inviteCode: 'INV2', tier: 'gold' })
    // the Stripe-keyed row is updated in place; no second row appears
    expect(tiersOf(store)).toEqual(new Map([['a@x.com', 'gold']]))
    expect(store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('INV2')
    expect(store.getMapping({ customerId: 'admin:a@x.com' })).toBeNull()
  })

  it('upsertPending replaces the placeholder on a real checkout', () => {
    const store = freshStore()
    store.upsertPendingByEmail({ email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    // one row per person: the admin placeholder yields to the Stripe mapping
    expect(store.getMapping({ customerId: 'admin:a@x.com' })).toBeNull()
    expect(tiersOf(store)).toEqual(new Map([['a@x.com', 'silver']]))
  })

  it('defaults the subscribed flag to false and a checkout sets it', () => {
    const store = freshStore()
    // admin-issued invite: no payment yet -> not subscribed
    store.upsertPendingByEmail({ email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    expect(store.allCustomerRows().get('a@x.com')?.subscribed).toBe(false)
    // a real checkout is the confirmed-payment path -> subscribed
    store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    expect(store.allCustomerRows().get('a@x.com')?.subscribed).toBe(true)
  })

  it('setSubscribed toggles every row for the email', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.setSubscribed({ email: 'a@x.com', value: false }) // a cancel clears it
    expect(store.allCustomerRows().get('a@x.com')?.subscribed).toBe(false)
    store.setSubscribed({ email: 'A@X.com', value: true }) // a renewal restores it (case-insensitive)
    expect(store.allCustomerRows().get('a@x.com')?.subscribed).toBe(true)
  })

  it('initDb adds the subscribed column to a legacy table', () => {
    const db = tempDbPath()
    // simulate a pre-payment-signal prod DB (has invited_at, lacks subscribed)
    execute({
      path: db,
      sql: [
        'CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, ' +
          'email TEXT, invite_code TEXT, tier TEXT, invited_at TEXT)',
        "INSERT INTO customer_map VALUES ('cus_legacy', 'old@x.com', 'i', 'gold', '2026-01-01T00:00:00+00:00')",
      ],
    })
    const store = openStore(db)
    store.init() // must ALTER, not crash, and default existing rows to false
    expect(store.allCustomerRows().get('old@x.com')?.subscribed).toBe(false)
  })

  it('allCustomerRows exposes the invite code', () => {
    // The reconcile sweep's invite-code fallback (Plex email differs from the
    // Stripe email) reads the code straight off the row.
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.stampInvited({ email: 'manual@x.com' }) // no bridge-issued code
    const rows = store.allCustomerRows()
    expect(rows.get('a@x.com')?.invite_code).toBe('abc')
    expect(rows.get('manual@x.com')?.invite_code).toBeNull()
  })

  it('stampInvited inserts a placeholder without a tier or payment', () => {
    const store = freshStore()
    store.stampInvited({ email: 'New@X.com' })
    const row = store.allCustomerRows().get('new@x.com')
    expect(row?.invited_at ?? null).not.toBeNull() // grace clock started
    expect(row?.tier).toBeNull() // no fabricated tier
    expect(row?.subscribed).toBe(false) // not a payment
  })

  it('stampInvited preserves the existing tier and flag', () => {
    const store = freshStore()
    // real payment: subscribed, gold
    store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.stampInvited({ email: 'A@X.com' })
    const row = store.allCustomerRows().get('a@x.com')
    expect(row?.tier).toBe('gold') // tier untouched
    expect(row?.subscribed).toBe(true) // payment flag untouched
    expect(store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('abc') // code untouched
  })

  it('setTier updates an existing row keeping its invite code', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.setTier({ email: 'a@x.com', tier: 'bronze' })
    expect(tiersOf(store)).toEqual(new Map([['a@x.com', 'bronze']]))
    expect(store.getMapping({ customerId: 'cus_1' })?.invite_code).toBe('abc') // untouched
  })

  it('setTier inserts a placeholder for an unknown email', () => {
    const store = freshStore()
    store.setTier({ email: 'New@X.com', tier: 'youth' })
    expect(tiersOf(store)).toEqual(new Map([['new@x.com', 'youth']]))
  })

  it('round-trips member notes lowercased and overwritten', () => {
    const store = freshStore()
    expect(store.getMemberNotes({ email: 'a@x.com' })).toBe('')
    store.setMemberNotes({ email: 'A@X.com', notes: 'prefers 4K' })
    expect(store.getMemberNotes({ email: 'a@x.com' })).toBe('prefers 4K') // keyed lowercased
    store.setMemberNotes({ email: 'a@x.com', notes: 'moved abroad' })
    expect(store.getMemberNotes({ email: 'A@X.com' })).toBe('moved abroad')
  })

  it('initDb adds the notes table to a legacy DB', () => {
    const db = tempDbPath()
    execute({
      path: db,
      sql: [
        'CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)',
      ],
    })
    const store = openStore(db)
    store.init() // must create member_notes on an existing DB
    store.setMemberNotes({ email: 'a@x.com', notes: 'legacy ok' })
    expect(store.getMemberNotes({ email: 'a@x.com' })).toBe('legacy ok')
  })

  it('round-trips event history newest first, lowercased', () => {
    const store = freshStore()
    expect(store.eventsForEmail({ email: 'a@x.com' })).toEqual([])
    store.recordEvent({
      email: 'A@X.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    store.recordEvent({ email: 'a@x.com', action: 'Canceled' })
    const events = store.eventsForEmail({ email: 'A@X.com' })
    expect(events.map((event) => event.action)).toEqual(['Canceled', 'Signed up'])
    expect(events[1]?.detail).toBe('gold tier — invite emailed')
    expect(events[0]?.email).toBe('a@x.com')
    expect(events.every((event) => !!event.at)).toBe(true)
  })

  it('recordEvent never throws', () => {
    // A history write failure must not break the action it records.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const missing = join(dirname(tempDbPath()), 'missing', 'no.db')
    expect(() =>
      openStore(missing).recordEvent({ email: 'a@x.com', action: 'Signed up' }),
    ).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
  })

  it('lists untiered rows too', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    store.upsertPending({ customerId: 'cus_2', email: 'b@x.com', inviteCode: 'def' }) // subscriber with no tier yet
    // the untiered row is kept (value null)
    expect(tiersOf(store)).toEqual(
      new Map([
        ['a@x.com', 'gold'],
        ['b@x.com', null],
      ]),
    )
  })

  it('customerIdsForEmail excludes admin placeholders', () => {
    const store = freshStore()

    expect(store.customerIdsForEmail({ email: 'a@example.com' })).toEqual([])

    store.upsertPending({ customerId: 'cus_1', email: 'A@Example.com', inviteCode: 'abc' })
    store.upsertPendingByEmail({ email: 'b@example.com', inviteCode: 'xyz' })
    expect(store.customerIdsForEmail({ email: 'a@example.com' })).toEqual(['cus_1'])
    expect(store.customerIdsForEmail({ email: 'b@example.com' })).toEqual([])
  })

  it('round-trips member tags lowercased and cleared', () => {
    const store = freshStore()

    expect(store.allMemberTags()).toEqual(new Map())
    store.setMemberTag({ email: 'A@Example.com', tag: 'vip' })
    store.setMemberTag({ email: 'b@example.com', tag: 'hvu' })
    expect(store.allMemberTags()).toEqual(
      new Map([
        ['a@example.com', 'vip'],
        ['b@example.com', 'hvu'],
      ]),
    )

    store.setMemberTag({ email: 'a@example.com', tag: 'hvu' }) // overwrite
    expect(store.allMemberTags().get('a@example.com')).toBe('hvu')

    store.setMemberTag({ email: 'A@example.com', tag: null }) // clear
    expect(store.allMemberTags()).toEqual(new Map([['b@example.com', 'hvu']]))
  })

  it('round-trips member downloads lowercased and overwritten', () => {
    const store = freshStore()

    expect(store.getMemberDownloads({ email: 'a@example.com' })).toBeNull()
    expect(store.allMemberDownloads()).toEqual(new Map())

    store.setMemberDownloads({ email: 'A@Example.com', allow: false })
    expect(store.getMemberDownloads({ email: 'a@example.com' })).toBe(false)

    store.setMemberDownloads({ email: 'a@example.com', allow: true })
    expect(store.getMemberDownloads({ email: 'A@example.com' })).toBe(true)
    expect(store.allMemberDownloads()).toEqual(new Map([['a@example.com', true]]))
  })

  it('keys member links lowercased and clears them', () => {
    const store = freshStore()
    store.setMemberLink({ stripeEmail: 'Pays@X.com', plexEmail: 'Watches@X.com' })
    expect(store.getMemberLink({ stripeEmail: 'pays@x.com' })).toBe('watches@x.com')
    expect(store.getMemberLink({ stripeEmail: 'PAYS@X.COM' })).toBe('watches@x.com')
    expect(store.allMemberLinks()).toEqual(new Map([['pays@x.com', 'watches@x.com']]))
    // Re-pointing replaces rather than duplicating; one payer, one owner.
    store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: 'other@x.com' })
    expect(store.allMemberLinks()).toEqual(new Map([['pays@x.com', 'other@x.com']]))
    store.setMemberLink({ stripeEmail: 'pays@x.com', plexEmail: null })
    expect(store.allMemberLinks()).toEqual(new Map())
    expect(store.getMemberLink({ stripeEmail: 'pays@x.com' })).toBeNull()
  })

  it('lets one person pay under several addresses', () => {
    const store = freshStore()
    store.setMemberLink({ stripeEmail: 'a@x.com', plexEmail: 'one@x.com' })
    store.setMemberLink({ stripeEmail: 'b@x.com', plexEmail: 'one@x.com' })
    expect(store.allMemberLinks()).toEqual(
      new Map([
        ['a@x.com', 'one@x.com'],
        ['b@x.com', 'one@x.com'],
      ]),
    )
  })

  /**
   * Several customers can share an email; which one answers must not be luck.
   *
   * The map is keyed on the Stripe customer id, so a member who checked out
   * more than once has a row per attempt. Collapsing them by email with no
   * ordering let whichever row SQLite happened to return last decide the
   * member's tier, invite code, and the customer id behind their Stripe link.
   *
   * subscribed and invited_at cannot break the tie: both are written across
   * every row sharing the email. The newest checkout is the live one, so
   * insertion order is the signal that actually distinguishes them.
   */
  it('resolves duplicate rows for one email to the newest real customer', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_old',
      email: 'dupe@x.com',
      inviteCode: 'OLD',
      tier: 'bronze',
    })
    store.upsertPending({
      customerId: 'cus_mid',
      email: 'dupe@x.com',
      inviteCode: 'MID',
      tier: 'gold',
    })
    store.upsertPending({
      customerId: 'cus_newest',
      email: 'dupe@x.com',
      inviteCode: 'NEWEST',
      tier: 'silver',
    })

    const row = store.allCustomerRows().get('dupe@x.com')
    expect(row?.customer_id).toBe('cus_newest')
    expect(row?.invite_code).toBe('NEWEST')
    expect(row?.tier).toBe('silver')
    // One entry per email either way; this is about which one, not how many.
    expect(store.allCustomerRows().size).toBe(1)
  })

  /**
   * An "admin:<email>" row carries no Stripe identity; a cus_ row does.
   *
   * Recency loses to that: a placeholder added after a real checkout would
   * otherwise blank the member's customer id and their Stripe link with it.
   */
  it('ranks a real customer above an admin placeholder', () => {
    const dbp = tempDbPath()
    const store = openStore(dbp)
    store.init()
    store.upsertPending({
      customerId: 'cus_real',
      email: 'both@x.com',
      inviteCode: 'REAL',
      tier: 'gold',
    })
    // a later placeholder, higher rowid
    execute({
      path: dbp,
      sql: [
        'INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier) ' +
          "VALUES ('admin:both@x.com', 'both@x.com', 'ADMIN', 'bronze')",
      ],
    })

    const row = store.allCustomerRows().get('both@x.com')
    expect(row?.customer_id).toBe('cus_real')
    expect(row?.invite_code).toBe('REAL')
  })

  it('leaves one row per email unaffected', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_1',
      email: 'solo@x.com',
      inviteCode: 'ONE',
      tier: 'silver',
    })
    const rows = store.allCustomerRows()
    expect(rows.size).toBe(1)
    expect(rows.get('solo@x.com')?.customer_id).toBe('cus_1')
    expect(rows.get('solo@x.com')?.invite_code).toBe('ONE')
  })

  it('allEvents spans every member newest first', () => {
    const store = freshStore()
    expect(store.allEvents()).toEqual([])
    store.recordEvent({
      email: 'A@X.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    store.recordEvent({
      email: 'b@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    })
    store.recordEvent({
      email: 'a@x.com',
      action: 'Canceled',
      detail: 'subscription ended — 1 server record(s) disabled',
    })
    const events = store.allEvents()
    expect(events.map((event) => [event.email, event.action])).toEqual([
      ['a@x.com', 'Canceled'],
      ['b@x.com', 'Signed up'],
      ['a@x.com', 'Signed up'],
    ])
    expect(store.allEvents({ limit: 1 })[0]?.action).toBe('Canceled')
  })

  it('customerIdsForEmail lists every real customer row', () => {
    const store = freshStore()
    store.upsertPending({
      customerId: 'cus_old',
      email: 'A@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    store.upsertPending({
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    expect(store.customerIdsForEmail({ email: 'a@X.com' })).toEqual(['cus_old', 'cus_new'])
    expect(store.customerIdsForEmail({ email: 'nobody@x.com' })).toEqual([])
  })
})
