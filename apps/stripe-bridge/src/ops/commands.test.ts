import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOpsCommand } from '@/ops/commands.js'
import { customerStore } from '@/store/customers.js'
import { eventStore } from '@/store/events.js'
import { inviteStore } from '@/store/invites.js'
import { openReadOnlyStore, openStore, readOnlyUnits } from '@/store/openStore.js'
import { overrideStore } from '@/store/overrides.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

/** A live-looking bridge.db: two members, a tag, an override, events and a baseline. */
const seeded = (): string => {
  const path = tempDbPath()
  const store = openStore(path)
  store.init()
  store.upsertPending({ customerId: 'cus_1', email: 'Ann@X.com', inviteCode: 'inv1', tier: 'gold' })
  store.upsertPending({ customerId: 'cus_2', email: 'bo@x.com', inviteCode: 'inv2' })
  store.setMemberTag({ email: 'bo@x.com', tag: 'vip' })
  store.setMemberDownloads({ email: 'ann@x.com', allow: true })
  store.recordEvent({ email: 'ann@x.com', action: 'signup', detail: 'gold' })
  store.recordEvent({ email: 'ann@x.com', action: 'invited', detail: 'inv1' })
  store.recordBaselineInvite({ code: 'BASE1', tier: 'gold', expiresAt: '2026-11-01T00:00:00' })
  return path
}

const run = ({ path, args }: { path: string; args: readonly string[] }) =>
  runOpsCommand({ args, store: openReadOnlyStore(path) })

describe('the ops CLI commands', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    removeTempDirs()
  })

  it('lists the baseline invites', () => {
    const answer = run({ path: seeded(), args: ['baselines'] })
    expect(answer).toMatchObject({
      ok: true,
      output: { baselines: [{ code: 'BASE1', tier: 'gold', expires_at: '2026-11-01T00:00:00' }] },
    })
  })

  it('lists one row per email, as the bridge reads it, and every tag', () => {
    const answer = run({ path: seeded(), args: ['customers'] })
    expect(answer).toMatchObject({
      ok: true,
      output: {
        customers: [
          { email: 'ann@x.com', customer_id: 'cus_1', invite_code: 'inv1', tier: 'gold' },
          { email: 'bo@x.com', customer_id: 'cus_2', invite_code: 'inv2', tier: null },
        ],
        tags: [{ email: 'bo@x.com', tag: 'vip' }],
      },
    })
  })

  it("answers one member's dossier, newest event first", () => {
    const answer = run({ path: seeded(), args: ['member', 'ANN@x.com'] })
    expect(answer).toMatchObject({
      ok: true,
      output: {
        email: 'ann@x.com',
        customer: { customer_id: 'cus_1', tier: 'gold' },
        customer_ids: ['cus_1'],
        tag: null,
        downloads: true,
        events: [{ action: 'invited' }, { action: 'signup' }],
      },
    })
  })

  it.each([[[]], [['drop']], [['member']], [['member', 'not-an-email']], [['baselines', 'x']]])(
    'refuses %j',
    (args) => {
      expect(run({ path: seeded(), args })).toEqual({ ok: false })
    },
  )
})

describe('the ops CLI cannot write', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    removeTempDirs()
  })

  // Byte for byte, sidecars included: a journal or WAL file appearing would
  // mean a write was at least begun.
  const snapshot = (path: string) => ({
    bytes: readFileSync(path),
    sidecars: ['-journal', '-wal', '-shm'].filter((suffix) => existsSync(`${path}${suffix}`)),
  })

  it('leaves the file untouched after every command', () => {
    const path = seeded()
    const before = snapshot(path)
    const commands = [['baselines'], ['customers'], ['member', 'ann@x.com']]
    commands.forEach((args) => expect(run({ path, args }).ok).toBe(true))
    const after = snapshot(path)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.sidecars).toEqual(before.sidecars)
  })

  it('hands out reads only', () => {
    const names = Object.keys(openReadOnlyStore(seeded()))
    expect(names.toSorted()).toEqual([
      'allBaselineInvites',
      'allCustomerRows',
      'allMemberTags',
      'customerIdsForEmail',
      'customerRow',
      'eventsForEmail',
      'getMemberDownloads',
      'getMemberTag',
    ])
  })

  // Even the store's own write operations, run over the CLI's connections,
  // are refused by SQLite: the read-only guarantee does not rest on the CLI
  // only calling reads.
  it('has every store write refused by SQLite and the file left as it was', () => {
    const path = seeded()
    const before = snapshot(path)
    const units = readOnlyUnits(path)
    const customers = customerStore(units)
    const overrides = overrideStore(units)
    const events = eventStore(units)
    const invites = inviteStore(units)
    const writes: readonly (readonly [string, () => unknown])[] = [
      [
        'upsertPending',
        () => customers.upsertPending({ customerId: 'cus_9', email: 'z@x.com', inviteCode: 'z' }),
      ],
      [
        'upsertPendingByEmail',
        () => customers.upsertPendingByEmail({ email: 'z@x.com', inviteCode: 'z' }),
      ],
      ['stampInvited', () => customers.stampInvited({ email: 'ann@x.com' })],
      ['setTier', () => customers.setTier({ email: 'ann@x.com', tier: 'bronze' })],
      ['setSubscribed', () => customers.setSubscribed({ email: 'ann@x.com', value: false })],
      [
        'setPaymentState',
        () => customers.setPaymentState({ email: 'ann@x.com', state: 'past_due' }),
      ],
      ['setMemberNotes', () => overrides.setMemberNotes({ email: 'ann@x.com', notes: 'n' })],
      ['setMemberTag', () => overrides.setMemberTag({ email: 'ann@x.com', tag: 'banned' })],
      [
        'setMemberDownloads',
        () => overrides.setMemberDownloads({ email: 'ann@x.com', allow: false }),
      ],
      [
        'setMemberLink',
        () => overrides.setMemberLink({ stripeEmail: 'ann@x.com', plexEmail: 'p@x.com' }),
      ],
      ['markEventProcessed', () => events.markEventProcessed({ eventId: 'evt_1' })],
      [
        'recordSessionInvite',
        () => invites.recordSessionInvite({ sessionId: 'cs_1', inviteCode: 'z' }),
      ],
      ['markSessionInviteEmailed', () => invites.markSessionInviteEmailed({ sessionId: 'cs_1' })],
      [
        'recordBaselineInvite',
        () =>
          invites.recordBaselineInvite({
            code: 'B2',
            tier: 'gold',
            expiresAt: '2027-01-01T00:00:00',
          }),
      ],
      ['forgetBaselineInvite', () => invites.forgetBaselineInvite({ code: 'BASE1' })],
    ]
    writes.forEach(([name, write]) => {
      expect(write, name).toThrow(/readonly|query_only/i)
    })
    // The event log swallows its own failures by design (a lost audit line
    // must not fail a webhook), so it is checked by what it left behind.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    events.recordEvent({ email: 'ann@x.com', action: 'tampered' })
    const after = snapshot(path)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.sidecars).toEqual(before.sidecars)
    expect(openReadOnlyStore(path).eventsForEmail({ email: 'ann@x.com' })).toHaveLength(2)
  })

  it('refuses a missing database rather than creating one', () => {
    const path = join(dirname(tempDbPath()), 'absent.db')
    expect(() => run({ path, args: ['baselines'] })).toThrow()
    expect(existsSync(path)).toBe(false)
  })
})
