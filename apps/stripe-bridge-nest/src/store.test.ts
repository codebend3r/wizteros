import { dirname, join } from 'node:path'
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allCustomerRows,
  allCustomerTiers,
  allEvents,
  allMemberDownloads,
  allMemberLinks,
  allMemberTags,
  customerIdsForEmail,
  eventsForEmail,
  getMapping,
  getMemberDownloads,
  getMemberLink,
  getMemberNotes,
  initDb,
  isEventProcessed,
  markEventProcessed,
  recordEvent,
  setMemberDownloads,
  setMemberLink,
  setMemberNotes,
  setMemberTag,
  setSubscribed,
  setTier,
  stampInvited,
  tiersByEmail,
  upsertPending,
  upsertPendingByEmail,
} from '@/store.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { withSqlite } from '@wizteros/server-common'

/** A fresh, initialised store, as each Python test's init_db(tmp_path / ...) did. */
const freshDb = (): string => {
  const path = tempDbPath()
  initDb({ path })
  return path
}

/** Run raw SQL against a file, the `with sqlite3.connect(db) as c:` of the Python tests. */
const execute = ({ path, sql }: { path: string; sql: readonly string[] }): void =>
  withSqlite({ path, work: (database) => sql.forEach((statement) => database.exec(statement)) })

describe('store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    removeTempDirs()
  })

  it('upserts and gets', () => {
    const db = freshDb()

    expect(getMapping({ path: db, customerId: 'cus_1' })).toBeNull()

    upsertPending({ path: db, customerId: 'cus_1', email: 'a@example.com', inviteCode: 'abc123' })
    expect(getMapping({ path: db, customerId: 'cus_1' })).toEqual({
      stripe_customer_id: 'cus_1',
      email: 'a@example.com',
      invite_code: 'abc123',
    })

    // upsert again updates email, keeps row unique
    upsertPending({ path: db, customerId: 'cus_1', email: 'b@example.com', inviteCode: 'abc123' })
    expect(getMapping({ path: db, customerId: 'cus_1' })?.email).toBe('b@example.com')

    // a new checkout re-points the mapping at the fresh invite code
    upsertPending({ path: db, customerId: 'cus_1', email: 'b@example.com', inviteCode: 'xyz789' })
    expect(getMapping({ path: db, customerId: 'cus_1' })?.invite_code).toBe('xyz789')
  })

  it('dedups mark event processed', () => {
    const db = freshDb()

    expect(markEventProcessed({ path: db, eventId: 'evt_1' })).toBe(true)
    expect(markEventProcessed({ path: db, eventId: 'evt_1' })).toBe(false)
  })

  it('reports whether an event is processed', () => {
    const db = freshDb()

    expect(isEventProcessed({ path: db, eventId: 'evt_1' })).toBe(false)
    markEventProcessed({ path: db, eventId: 'evt_1' })
    expect(isEventProcessed({ path: db, eventId: 'evt_1' })).toBe(true)
  })

  it('persists the tier and looks it up by email', () => {
    const db = freshDb()

    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    upsertPending({ path: db, customerId: 'cus_2', email: 'b@x.com', inviteCode: 'def' }) // tier defaults to null

    // lookup is lowercased and only includes rows that have a tier
    expect(tiersByEmail({ path: db })).toEqual(new Map([['a@x.com', 'gold']]))
    // existing mapping shape is unchanged (no tier key)
    expect(getMapping({ path: db, customerId: 'cus_1' })).toEqual({
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
    initDb({ path: db }) // must ALTER, not crash
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    expect(tiersByEmail({ path: db })).toEqual(new Map([['a@x.com', 'silver']]))
  })

  it('upsertPendingByEmail inserts a placeholder row', () => {
    const db = freshDb()
    upsertPendingByEmail({ path: db, email: 'Code@X.com', inviteCode: 'INV1', tier: 'gold' })
    expect(allCustomerTiers({ path: db })).toEqual(new Map([['code@x.com', 'gold']]))
  })

  it('upsertPendingByEmail re-points an existing Stripe row', () => {
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    upsertPendingByEmail({ path: db, email: 'a@x.com', inviteCode: 'INV2', tier: 'gold' })
    // the Stripe-keyed row is updated in place; no second row appears
    expect(allCustomerTiers({ path: db })).toEqual(new Map([['a@x.com', 'gold']]))
    expect(getMapping({ path: db, customerId: 'cus_1' })?.invite_code).toBe('INV2')
    expect(getMapping({ path: db, customerId: 'admin:a@x.com' })).toBeNull()
  })

  it('upsertPending replaces the placeholder on a real checkout', () => {
    const db = freshDb()
    upsertPendingByEmail({ path: db, email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'silver',
    })
    // one row per person: the admin placeholder yields to the Stripe mapping
    expect(getMapping({ path: db, customerId: 'admin:a@x.com' })).toBeNull()
    expect(allCustomerTiers({ path: db })).toEqual(new Map([['a@x.com', 'silver']]))
  })

  it('defaults the subscribed flag to false and a checkout sets it', () => {
    const db = freshDb()
    // admin-issued invite: no payment yet -> not subscribed
    upsertPendingByEmail({ path: db, email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    expect(allCustomerRows({ path: db }).get('a@x.com')?.subscribed).toBe(false)
    // a real checkout is the confirmed-payment path -> subscribed
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    expect(allCustomerRows({ path: db }).get('a@x.com')?.subscribed).toBe(true)
  })

  it('setSubscribed toggles every row for the email', () => {
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    setSubscribed({ path: db, email: 'a@x.com', value: false }) // a cancel clears it
    expect(allCustomerRows({ path: db }).get('a@x.com')?.subscribed).toBe(false)
    setSubscribed({ path: db, email: 'A@X.com', value: true }) // a renewal restores it (case-insensitive)
    expect(allCustomerRows({ path: db }).get('a@x.com')?.subscribed).toBe(true)
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
    initDb({ path: db }) // must ALTER, not crash, and default existing rows to false
    expect(allCustomerRows({ path: db }).get('old@x.com')?.subscribed).toBe(false)
  })

  it('allCustomerRows exposes the invite code', () => {
    // The reconcile sweep's invite-code fallback (Plex email differs from the
    // Stripe email) reads the code straight off the row.
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    stampInvited({ path: db, email: 'manual@x.com' }) // no bridge-issued code
    const rows = allCustomerRows({ path: db })
    expect(rows.get('a@x.com')?.invite_code).toBe('abc')
    expect(rows.get('manual@x.com')?.invite_code).toBeNull()
  })

  it('stampInvited inserts a placeholder without a tier or payment', () => {
    const db = freshDb()
    stampInvited({ path: db, email: 'New@X.com' })
    const row = allCustomerRows({ path: db }).get('new@x.com')
    expect(row?.invited_at ?? null).not.toBeNull() // grace clock started
    expect(row?.tier).toBeNull() // no fabricated tier
    expect(row?.subscribed).toBe(false) // not a payment
  })

  it('stampInvited preserves the existing tier and flag', () => {
    const db = freshDb()
    // real payment: subscribed, gold
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    stampInvited({ path: db, email: 'A@X.com' })
    const row = allCustomerRows({ path: db }).get('a@x.com')
    expect(row?.tier).toBe('gold') // tier untouched
    expect(row?.subscribed).toBe(true) // payment flag untouched
    expect(getMapping({ path: db, customerId: 'cus_1' })?.invite_code).toBe('abc') // code untouched
  })

  it('setTier updates an existing row keeping its invite code', () => {
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    setTier({ path: db, email: 'a@x.com', tier: 'bronze' })
    expect(allCustomerTiers({ path: db })).toEqual(new Map([['a@x.com', 'bronze']]))
    expect(getMapping({ path: db, customerId: 'cus_1' })?.invite_code).toBe('abc') // untouched
  })

  it('setTier inserts a placeholder for an unknown email', () => {
    const db = freshDb()
    setTier({ path: db, email: 'New@X.com', tier: 'youth' })
    expect(allCustomerTiers({ path: db })).toEqual(new Map([['new@x.com', 'youth']]))
  })

  it('round-trips member notes lowercased and overwritten', () => {
    const db = freshDb()
    expect(getMemberNotes({ path: db, email: 'a@x.com' })).toBe('')
    setMemberNotes({ path: db, email: 'A@X.com', notes: 'prefers 4K' })
    expect(getMemberNotes({ path: db, email: 'a@x.com' })).toBe('prefers 4K') // keyed lowercased
    setMemberNotes({ path: db, email: 'a@x.com', notes: 'moved abroad' })
    expect(getMemberNotes({ path: db, email: 'A@X.com' })).toBe('moved abroad')
  })

  it('initDb adds the notes table to a legacy DB', () => {
    const db = tempDbPath()
    execute({
      path: db,
      sql: [
        'CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)',
      ],
    })
    initDb({ path: db }) // must create member_notes on an existing DB
    setMemberNotes({ path: db, email: 'a@x.com', notes: 'legacy ok' })
    expect(getMemberNotes({ path: db, email: 'a@x.com' })).toBe('legacy ok')
  })

  it('round-trips event history newest first, lowercased', () => {
    const db = freshDb()
    expect(eventsForEmail({ path: db, email: 'a@x.com' })).toEqual([])
    recordEvent({
      path: db,
      email: 'A@X.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    recordEvent({ path: db, email: 'a@x.com', action: 'Canceled' })
    const events = eventsForEmail({ path: db, email: 'A@X.com' })
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
      recordEvent({ path: missing, email: 'a@x.com', action: 'Signed up' }),
    ).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
  })

  it('allCustomerTiers includes untiered rows', () => {
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_1',
      email: 'A@X.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    upsertPending({ path: db, customerId: 'cus_2', email: 'b@x.com', inviteCode: 'def' }) // subscriber with no tier yet
    // unlike tiersByEmail, the untiered row is kept (value null)
    expect(allCustomerTiers({ path: db })).toEqual(
      new Map([
        ['a@x.com', 'gold'],
        ['b@x.com', null],
      ]),
    )
  })

  it('customerIdsForEmail excludes admin placeholders', () => {
    const db = freshDb()

    expect(customerIdsForEmail({ path: db, email: 'a@example.com' })).toEqual([])

    upsertPending({ path: db, customerId: 'cus_1', email: 'A@Example.com', inviteCode: 'abc' })
    upsertPendingByEmail({ path: db, email: 'b@example.com', inviteCode: 'xyz' })
    expect(customerIdsForEmail({ path: db, email: 'a@example.com' })).toEqual(['cus_1'])
    expect(customerIdsForEmail({ path: db, email: 'b@example.com' })).toEqual([])
  })

  it('round-trips member tags lowercased and cleared', () => {
    const db = freshDb()

    expect(allMemberTags({ path: db })).toEqual(new Map())
    setMemberTag({ path: db, email: 'A@Example.com', tag: 'vip' })
    setMemberTag({ path: db, email: 'b@example.com', tag: 'hvu' })
    expect(allMemberTags({ path: db })).toEqual(
      new Map([
        ['a@example.com', 'vip'],
        ['b@example.com', 'hvu'],
      ]),
    )

    setMemberTag({ path: db, email: 'a@example.com', tag: 'hvu' }) // overwrite
    expect(allMemberTags({ path: db }).get('a@example.com')).toBe('hvu')

    setMemberTag({ path: db, email: 'A@example.com', tag: null }) // clear
    expect(allMemberTags({ path: db })).toEqual(new Map([['b@example.com', 'hvu']]))
  })

  it('round-trips member downloads lowercased and overwritten', () => {
    const db = freshDb()

    expect(getMemberDownloads({ path: db, email: 'a@example.com' })).toBeNull()
    expect(allMemberDownloads({ path: db })).toEqual(new Map())

    setMemberDownloads({ path: db, email: 'A@Example.com', allow: false })
    expect(getMemberDownloads({ path: db, email: 'a@example.com' })).toBe(false)

    setMemberDownloads({ path: db, email: 'a@example.com', allow: true })
    expect(getMemberDownloads({ path: db, email: 'A@example.com' })).toBe(true)
    expect(allMemberDownloads({ path: db })).toEqual(new Map([['a@example.com', true]]))
  })

  it('keys member links lowercased and clears them', () => {
    const dbp = freshDb()
    setMemberLink({ path: dbp, stripeEmail: 'Pays@X.com', plexEmail: 'Watches@X.com' })
    expect(getMemberLink({ path: dbp, stripeEmail: 'pays@x.com' })).toBe('watches@x.com')
    expect(getMemberLink({ path: dbp, stripeEmail: 'PAYS@X.COM' })).toBe('watches@x.com')
    expect(allMemberLinks({ path: dbp })).toEqual(new Map([['pays@x.com', 'watches@x.com']]))
    // Re-pointing replaces rather than duplicating; one payer, one owner.
    setMemberLink({ path: dbp, stripeEmail: 'pays@x.com', plexEmail: 'other@x.com' })
    expect(allMemberLinks({ path: dbp })).toEqual(new Map([['pays@x.com', 'other@x.com']]))
    setMemberLink({ path: dbp, stripeEmail: 'pays@x.com', plexEmail: null })
    expect(allMemberLinks({ path: dbp })).toEqual(new Map())
    expect(getMemberLink({ path: dbp, stripeEmail: 'pays@x.com' })).toBeNull()
  })

  it('lets one person pay under several addresses', () => {
    const dbp = freshDb()
    setMemberLink({ path: dbp, stripeEmail: 'a@x.com', plexEmail: 'one@x.com' })
    setMemberLink({ path: dbp, stripeEmail: 'b@x.com', plexEmail: 'one@x.com' })
    expect(allMemberLinks({ path: dbp })).toEqual(
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
    const dbp = freshDb()
    upsertPending({
      path: dbp,
      customerId: 'cus_old',
      email: 'dupe@x.com',
      inviteCode: 'OLD',
      tier: 'bronze',
    })
    upsertPending({
      path: dbp,
      customerId: 'cus_mid',
      email: 'dupe@x.com',
      inviteCode: 'MID',
      tier: 'gold',
    })
    upsertPending({
      path: dbp,
      customerId: 'cus_newest',
      email: 'dupe@x.com',
      inviteCode: 'NEWEST',
      tier: 'silver',
    })

    const row = allCustomerRows({ path: dbp }).get('dupe@x.com')
    expect(row?.customer_id).toBe('cus_newest')
    expect(row?.invite_code).toBe('NEWEST')
    expect(row?.tier).toBe('silver')
    // One entry per email either way; this is about which one, not how many.
    expect(allCustomerRows({ path: dbp }).size).toBe(1)
  })

  /**
   * An "admin:<email>" row carries no Stripe identity; a cus_ row does.
   *
   * Recency loses to that: a placeholder added after a real checkout would
   * otherwise blank the member's customer id and their Stripe link with it.
   */
  it('ranks a real customer above an admin placeholder', () => {
    const dbp = freshDb()
    upsertPending({
      path: dbp,
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

    const row = allCustomerRows({ path: dbp }).get('both@x.com')
    expect(row?.customer_id).toBe('cus_real')
    expect(row?.invite_code).toBe('REAL')
  })

  it('leaves one row per email unaffected', () => {
    const dbp = freshDb()
    upsertPending({
      path: dbp,
      customerId: 'cus_1',
      email: 'solo@x.com',
      inviteCode: 'ONE',
      tier: 'silver',
    })
    const rows = allCustomerRows({ path: dbp })
    expect(rows.size).toBe(1)
    expect(rows.get('solo@x.com')?.customer_id).toBe('cus_1')
    expect(rows.get('solo@x.com')?.invite_code).toBe('ONE')
  })

  it('allEvents spans every member newest first', () => {
    const db = freshDb()
    expect(allEvents({ path: db })).toEqual([])
    recordEvent({
      path: db,
      email: 'A@X.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    recordEvent({
      path: db,
      email: 'b@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    })
    recordEvent({
      path: db,
      email: 'a@x.com',
      action: 'Canceled',
      detail: 'subscription ended — 1 server record(s) disabled',
    })
    const events = allEvents({ path: db })
    expect(events.map((event) => [event.email, event.action])).toEqual([
      ['a@x.com', 'Canceled'],
      ['b@x.com', 'Signed up'],
      ['a@x.com', 'Signed up'],
    ])
    expect(allEvents({ path: db, limit: 1 })[0]?.action).toBe('Canceled')
  })

  it('customerIdsForEmail lists every real customer row', () => {
    const db = freshDb()
    upsertPending({
      path: db,
      customerId: 'cus_old',
      email: 'A@x.com',
      inviteCode: 'old',
      tier: 'bronze',
    })
    upsertPending({
      path: db,
      customerId: 'cus_new',
      email: 'a@x.com',
      inviteCode: 'new',
      tier: 'silver',
    })
    expect(customerIdsForEmail({ path: db, email: 'a@X.com' })).toEqual(['cus_old', 'cus_new'])
    expect(customerIdsForEmail({ path: db, email: 'nobody@x.com' })).toEqual([])
  })
})
