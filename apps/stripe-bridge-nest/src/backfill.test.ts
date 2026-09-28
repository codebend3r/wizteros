import { afterEach, describe, expect, it } from 'vitest'
import { runBackfill } from '@/backfill.js'
import { type BridgeStore, openStore } from '@/store/openStore.js'
import { type FakeWizarr, fakeWizarr } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

/** A fresh store and a Wizarr fake whose every email maps to records 9 and 10. */
const setup = (): { store: BridgeStore; client: FakeWizarr } => {
  const store = openStore(tempDbPath())
  store.init()
  const client = fakeWizarr()
  client.findUserIdsByEmail.mockResolvedValue([9, 10])
  return { store, client }
}

/** The record ids setExpiry was called with, sorted. */
const expiredIds = (client: FakeWizarr): number[] =>
  client.setExpiry.mock.calls.map(([update]) => update.userId).toSorted((a, b) => a - b)

describe('backfill', () => {
  afterEach(() => {
    removeTempDirs()
  })

  it('stamps invited and expires a plain member', async () => {
    const { store, client } = setup()
    await runBackfill({ store, wizarr: client, dryRun: false, emails: ['new@x.com'] })
    const row = store.allCustomerRows().get('new@x.com')
    expect(row?.invited_at).toBeTruthy() // reads as Invited
    expect(row?.subscribed).toBe(false) // not marked a subscriber
    expect(row?.tier).toBeNull() // tier stays Unknown
    // every Wizarr record gets the 14-day expiry
    expect(expiredIds(client)).toEqual([9, 10])
    const events = store.eventsForEmail({ email: 'new@x.com' })
    expect(events[0]?.action).toBe('Invited')
    expect(events[0]?.detail).toContain('access ends')
  })

  it('skips VIP and already subscribed members', async () => {
    const { store, client } = setup()
    store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    // confirmed payment
    store.upsertPending({
      customerId: 'cus_1',
      email: 'paid@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    await runBackfill({
      store,
      wizarr: client,
      dryRun: false,
      emails: ['vip@x.com', 'paid@x.com'],
    })
    expect(client.setExpiry).not.toHaveBeenCalled() // neither member is time-boxed
    expect(store.allCustomerRows().has('vip@x.com')).toBe(false) // VIP never stamped
  })

  it('treats an hvu member as a normal member', async () => {
    const { store, client } = setup()
    store.setMemberTag({ email: 'hvu@x.com', tag: 'hvu' }) // administrative label, not protected
    await runBackfill({ store, wizarr: client, dryRun: false, emails: ['hvu@x.com'] })
    expect(store.allCustomerRows().get('hvu@x.com')?.invited_at).toBeTruthy()
    expect(expiredIds(client)).toEqual([9, 10])
  })

  it('writes nothing on a dry run', async () => {
    const { store, client } = setup()
    await runBackfill({ store, wizarr: client, dryRun: true, emails: ['new@x.com'] })
    expect(client.setExpiry).not.toHaveBeenCalled()
    expect(store.allCustomerRows().has('new@x.com')).toBe(false)
  })

  it('sets the expiry expiryDays after now', async () => {
    const { store, client } = setup()
    const now = new Date(Date.UTC(2026, 6, 25, 12, 0, 0))
    const summary = await runBackfill({
      store,
      wizarr: client,
      dryRun: false,
      emails: ['new@x.com'],
      now,
    })
    expect(client.setExpiry).toHaveBeenCalledWith({
      userId: 9,
      expires: '2026-08-08T12:00:00+00:00',
    })
    expect(summary).toEqual({ stamped: 1, skipped: 0, total: 1 })
  })
})
