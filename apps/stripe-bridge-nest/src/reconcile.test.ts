import { Logger } from '@nestjs/common'
import { parseIso, withSqlite } from '@wizteros/server-common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcilePendingExpiries } from '@/reconcile.js'
import {
  allCustomerRows,
  eventsForEmail,
  initDb,
  setMemberLink,
  setMemberTag,
  stampInvited,
  upsertPending,
} from '@/store.js'
import { asBridge, type FakeBridge, fakeBridge } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

const DAY_MS = 86_400_000

let bridge: FakeBridge
let path: string

beforeEach(() => {
  path = tempDbPath()
  bridge = fakeBridge({ dbPath: path })
  initDb({ path })
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTempDirs()
})

const reconcile = (): Promise<number> => reconcilePendingExpiries(asBridge(bridge))

const stampedIds = (): number[] => bridge.wizarr.setExpiry.mock.calls.map(([call]) => call.userId)
const stampedAt = (): number[] =>
  bridge.wizarr.setExpiry.mock.calls.map(([call]) => parseIso(call.expires ?? '').getTime())
const byNumber = (a: number, b: number): number => a - b

/** The member's signup anchor as stored, in epoch milliseconds. */
const invitedAt = (email: string): number =>
  parseIso(allCustomerRows({ path }).get(email)?.invited_at ?? '').getTime()

describe('reconcilePendingExpiries', () => {
  it('stamps new member records that joined without an expiry', async () => {
    // Wizarr never applies an invite's duration to the records it creates, so a
    // brand-new member redeems into expires=None. The sweep must stamp
    // invited_at + ACCESS_DURATION on exactly those records.
    upsertPending({
      path,
      customerId: 'cus_1',
      email: 'new@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 259, email: 'new@x.com', server: 'Vermithor', expires: null },
      { id: 260, email: 'new@x.com', server: 'Meleys', expires: null },
      { id: 9, email: 'other@x.com', server: 'Vermithor', expires: null },
    ])
    expect(await reconcile()).toBe(2)
    expect(stampedIds().toSorted(byNumber)).toEqual([259, 260])
    const expected = invitedAt('new@x.com') + 35 * DAY_MS
    expect(stampedAt().every((at) => at === expected)).toBe(true)
    const events = eventsForEmail({ path, email: 'new@x.com' })
    expect(events[0]?.action).toBe('Expiry stamped')
  })

  it('skips VIPs and records that carry an expiry', async () => {
    upsertPending({ path, customerId: 'cus_1', email: 'vip@x.com', inviteCode: 'abc' })
    setMemberTag({ path, email: 'vip@x.com', tag: 'vip' })
    upsertPending({ path, customerId: 'cus_2', email: 'paid@x.com', inviteCode: 'def' })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'vip@x.com', server: 'Vermithor', expires: null },
      { id: 2, email: 'paid@x.com', server: 'Vermithor', expires: '2099-01-01T00:00:00' },
    ])
    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('ignores unsubscribed members', async () => {
    stampInvited({ path, email: 'invited@x.com' }) // invited, never paid
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'invited@x.com', server: 'Vermithor', expires: null },
    ])
    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    // nothing pending at all -> the slow Wizarr users call is skipped entirely
    expect(bridge.wizarr.listUsers).not.toHaveBeenCalled()
  })

  it('never stamps a date already in the past', async () => {
    // A stale signup anchor must not revoke access, and must not be ignored either.
    //
    // Skipping these rows outright is what left a paying member with no expiry
    // at all: their signup is older than the access window, so the computed date
    // is always past and the sweep passed over them forever. Re-anchor at the
    // sweep instead, which is the same window every payment grants.
    upsertPending({ path, customerId: 'cus_1', email: 'old@x.com', inviteCode: 'abc' })
    withSqlite({
      path,
      work: (database) =>
        database.prepare("UPDATE customer_map SET invited_at = '2020-01-01T00:00:00+00:00'").run(),
    })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'old@x.com', server: 'Vermithor', expires: null },
    ])
    const before = Date.now()

    expect(await reconcile()).toBe(1)

    const stamped = stampedAt().at(-1) ?? 0
    // the sweep must never stamp a date that is already past
    expect(stamped).toBeGreaterThan(before)
    expect(stamped).toBeLessThanOrEqual(Date.now() + 35 * DAY_MS)
    const events = eventsForEmail({ path, email: 'old@x.com' })
    expect(events[0]?.action).toBe('Expiry stamped')
    expect(events[0]?.detail).toContain('signup window had already lapsed')
  })

  it('stamps a linked member under their Plex address', async () => {
    // The payer is the subscribed row; the records live under the other address.
    //
    // Neither existing path reaches them: nothing matches the Stripe email, and
    // the invite their checkout issued was never redeemed, so the invite
    // fallback finds nothing either. Without the link they keep unbounded access.
    upsertPending({
      path,
      customerId: 'cus_live',
      email: 'pays@x.com',
      inviteCode: 'INVNEW',
      tier: 'bronze',
    })
    setMemberLink({ path, stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 287, email: 'watches@x.com', server: 'Vermithor', expires: null },
      { id: 288, email: 'watches@x.com', server: 'Meleys', expires: null },
    ])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([]) // unredeemed

    expect(await reconcile()).toBe(2)

    expect(stampedIds().toSorted(byNumber)).toEqual([287, 288])
    const expected = invitedAt('pays@x.com') + 35 * DAY_MS
    expect(stampedAt().every((at) => at === expected)).toBe(true)
  })

  it("leaves a linked member's stamped records alone", async () => {
    // Resolving through the link must not re-stamp what already has an expiry.
    upsertPending({ path, customerId: 'cus_live', email: 'pays@x.com', inviteCode: 'INVNEW' })
    setMemberLink({ path, stripeEmail: 'pays@x.com', plexEmail: 'watches@x.com' })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 287, email: 'watches@x.com', server: 'Vermithor', expires: '2099-01-01T00:00:00' },
    ])
    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('falls back to the invite code when the Plex email differs', async () => {
    // A brand-new member may create their Plex account under a different email
    // (relay addresses, Google/Apple sign-up), so the email join finds nothing
    // and their records would otherwise never get an expiry. The sweep must
    // then locate the records through the invite the member redeemed.
    upsertPending({
      path,
      customerId: 'cus_1',
      email: 'stripe@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 300, email: 'relay@privaterelay.example', server: 'Meleys', expires: null },
      { id: 9, email: 'other@x.com', server: 'Meleys', expires: null },
    ])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([300])
    expect(await reconcile()).toBe(1)
    expect(bridge.wizarr.findUserIdsByInvite).toHaveBeenCalledExactlyOnceWith('abc')
    expect(stampedIds()).toEqual([300])
    const events = eventsForEmail({ path, email: 'stripe@x.com' })
    expect(events[0]?.action).toBe('Expiry stamped')
  })

  it('skips the invite lookup when the email matches stamped records', async () => {
    // An email-resolvable member whose records already carry an expiry needs no
    // fallback; the invite lookup costs live Wizarr calls per member per sweep.
    upsertPending({ path, customerId: 'cus_1', email: 'paid@x.com', inviteCode: 'abc' })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 2, email: 'paid@x.com', server: 'Meleys', expires: '2099-01-01T00:00:00' },
    ])
    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.findUserIdsByInvite).not.toHaveBeenCalled()
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('stamps nothing through the invite fallback on an unredeemed invite', async () => {
    // Paid but not yet redeemed: no records exist anywhere, and the invite has
    // no used_by yet, so the sweep must leave everything alone until next time.
    upsertPending({ path, customerId: 'cus_1', email: 'pending@x.com', inviteCode: 'abc' })
    bridge.wizarr.listUsers.mockResolvedValue([])
    bridge.wizarr.findUserIdsByInvite.mockResolvedValue([])
    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('skips banned members', async () => {
    upsertPending({
      path,
      customerId: 'cus_1',
      email: 'banned@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    setMemberTag({ path, email: 'banned@x.com', tag: 'banned' })
    bridge.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'banned@x.com', server: 'Meleys', expires: null },
    ])

    expect(await reconcile()).toBe(0)
    expect(bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })
})
