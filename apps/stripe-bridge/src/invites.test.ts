import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueInvite, rescopeRecords } from '@/invites.js'
import { asBridge, type FakeBridge, fakeBridge, fakeWizarr } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { Tier } from '@/tiers.js'
import type { TierScope } from '@/types.js'

const SCOPE: TierScope = {
  library_ids: [17],
  server_ids: [2],
  server_names: ['Meleys'],
  allow_downloads: false,
}

let fake: FakeBridge

beforeEach(() => {
  fake = fakeBridge({ dbPath: tempDbPath() })
  fake.store.init()
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTempDirs()
})

describe('rescopeRecords', () => {
  it('keeps records on covered servers and disables none', async () => {
    const wizarr = fakeWizarr()
    const records = [
      { id: 1, server: 'Meleys' },
      { id: 2, server: 'Meleys' },
    ]
    const out = await rescopeRecords({
      wizarr,
      records,
      coveredServers: ['Meleys'],
      evaluable: true,
    })
    expect(out).toEqual({ disabled: [], surviving: records })
    expect(wizarr.disableUser).not.toHaveBeenCalled()
  })

  it('disables every record, in order, when one server is left uncovered', async () => {
    const wizarr = fakeWizarr()
    const out = await rescopeRecords({
      wizarr,
      records: [
        { id: 1, server: 'Meleys' },
        { id: 2, server: 'Vhagar' },
      ],
      coveredServers: ['Meleys'],
      evaluable: true,
    })
    expect(out).toEqual({ disabled: [1, 2], surviving: [] })
    expect(wizarr.disableUser.mock.calls).toEqual([[1], [2]])
  })

  it('fails closed when coverage cannot be judged', async () => {
    const wizarr = fakeWizarr()
    const out = await rescopeRecords({
      wizarr,
      records: [{ id: 7, server: 'Meleys' }],
      coveredServers: ['Meleys'],
      evaluable: false,
    })
    expect(out.disabled).toEqual([7])
  })
})

describe('issueInvite', () => {
  it('reuses the invite a checkout session already minted', async () => {
    fake.wizarr.createInvite.mockResolvedValue({ code: 'abc', url: 'http://x/j/abc' })
    const bridge = asBridge(fake)
    const tier: Tier = 'bronze'
    const args = {
      bridge,
      email: 'a@x.com',
      tier,
      scope: SCOPE,
      sessionId: 'cs_1',
    }

    const first = await issueInvite({ ...args, customerId: 'cus_1' })
    fake.store.markSessionInviteEmailed({ sessionId: 'cs_1' })
    const retry = await issueInvite({ ...args, customerId: 'cus_1' })

    expect(fake.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ code: 'abc', url: 'http://inv.test/j/abc', emailed: false })
    expect(retry).toMatchObject({ code: 'abc', emailed: true })
  })

  it('settles a failed payment in the same write as the pending row', async () => {
    fake.store.upsertPending({ customerId: 'cus_1', email: 'a@x.com', inviteCode: 'old' })
    fake.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    fake.wizarr.createInvite.mockResolvedValue({ code: 'new', url: 'http://x/j/new' })

    await issueInvite({
      bridge: asBridge(fake),
      email: 'a@x.com',
      tier: 'gold',
      scope: SCOPE,
      customerId: 'cus_1',
      settlesPayment: true,
    })

    const row = fake.store.customerRow({ email: 'a@x.com' })
    expect(row?.invite_code).toBe('new')
    expect(row?.payment_state).toBeNull()
  })

  it('records an invite with no customer against the address', async () => {
    fake.wizarr.createInvite.mockResolvedValue({ code: 'adm', url: 'http://x/j/adm' })
    await issueInvite({ bridge: asBridge(fake), email: 'b@x.com', tier: 'silver', scope: SCOPE })
    expect(fake.store.customerRow({ email: 'b@x.com' })?.invite_code).toBe('adm')
  })
})
