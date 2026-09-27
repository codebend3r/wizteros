// The roster's pure functions on their own. The admin route tests reach them
// too (see admin/adminController.test.ts); these pin the ordering and
// empty-value details a route test would only catch by accident.

import { describe, expect, it } from 'vitest'
import {
  assembleMembers,
  customerByPlexEmail,
  dedupeMembers,
  memberFromCustomer,
  plexEmailByInvite,
  withOverrides,
  withPlexAccess,
} from '@/roster.js'
import type { CustomerRow, Member, WizarrLibrary } from '@/types.js'

const LIBRARIES: readonly WizarrLibrary[] = [
  { id: 1, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
]

const row = (fields: Partial<CustomerRow> = {}): CustomerRow => ({
  customer_id: 'cus_1',
  invite_code: null,
  tier: 'bronze',
  invited_at: null,
  subscribed: true,
  payment_state: null,
  ...fields,
})

describe('plexEmailByInvite', () => {
  it('keys redeemed invites by lowercased code and drops the unresolved', () => {
    const users = [{ id: 3, username: 'nora', email: 'Nora@X.com' }]
    const found = plexEmailByInvite({
      invitations: [
        { id: 1, code: 'INV1', used_by: '<User 3>' },
        { id: 2, code: 'INV2', used_by: null },
        { id: 3, code: null, used_by: '<User 3>' },
      ],
      users,
    })
    expect(found).toEqual(new Map([['inv1', 'nora@x.com']]))
  })
})

describe('customerByPlexEmail', () => {
  it('prefers a manual link, and treats an empty one as no link', () => {
    const customers = new Map([
      ['pays@x.com', row({ invite_code: 'INV1' })],
      ['other@x.com', row({ invite_code: 'INV2' })],
    ])
    const linked = customerByPlexEmail({
      customers,
      plexEmailByInvite: new Map([
        ['inv1', 'redeemer@x.com'],
        ['inv2', 'watches@x.com'],
      ]),
      manualLinks: new Map([
        ['pays@x.com', 'stated@x.com'],
        ['other@x.com', ''],
      ]),
    })
    expect([...linked.keys()]).toEqual(['stated@x.com', 'watches@x.com'])
    expect(linked.get('stated@x.com')?.manual_link ?? null).toBe(true)
    expect(linked.get('watches@x.com')?.manual_link ?? null).toBe(false)
  })

  it('leaves out a customer resolving to its own address', () => {
    const linked = customerByPlexEmail({
      customers: new Map([['a@x.com', row({ invite_code: 'INV1' })]]),
      plexEmailByInvite: new Map([['inv1', 'a@x.com']]),
    })
    expect(linked.size).toBe(0)
  })
})

describe('dedupeMembers', () => {
  it("keeps the first record's name, sorts servers, and skips a keyless record", () => {
    const [person, ...rest] = dedupeMembers({
      users: [
        { id: 1, username: 'First', email: ' A@x.com ', server: 'Vhagar' },
        { id: 2, username: 'second', email: 'a@X.com', server: 'Meleys' },
        { id: 3, username: 'third', email: 'a@x.com', server: 'Vhagar' },
        { id: 4, username: null, email: null },
      ],
      customers: new Map(),
      libraries: LIBRARIES,
    })
    expect(rest).toEqual([])
    expect(person?.member ?? null).toBe('First')
    expect(person?.email ?? null).toBe('A@x.com')
    expect(person?.servers ?? null).toEqual(['Meleys', 'Vhagar'])
  })

  it('sorts by lowercased name, stable on ties, by code unit rather than locale', () => {
    const names = dedupeMembers({
      users: [
        { id: 1, username: 'bob', email: 'b1@x.com' },
        { id: 2, username: 'Zed', email: 'z@x.com' },
        { id: 3, username: 'Bob', email: 'b2@x.com' },
        { id: 4, username: '_under', email: 'u@x.com' },
      ],
      customers: new Map(),
      libraries: LIBRARIES,
    }).map((m) => m.email)
    // '_' sorts after the letters' uppercase block but before lowercase ones
    expect(names).toEqual(['u@x.com', 'b1@x.com', 'b2@x.com', 'z@x.com'])
  })
})

describe('memberFromCustomer', () => {
  it('names the member after the local part and holds nothing yet', () => {
    const member = memberFromCustomer({
      email: 'max@x.com',
      row: row({ tier: 'kids' }),
      libraries: LIBRARIES,
    })
    expect(member.member).toBe('max')
    expect(member.tier).toBe('youth') // the legacy alias
    expect(member.servers).toEqual([])
    expect(member.libraries).toEqual({})
    expect(member.stripe_email).toBeNull()
  })
})

describe('withPlexAccess and withOverrides', () => {
  const member: Member = {
    member: 'cj',
    email: 'A@x.com',
    tier: 'bronze',
    downloads: false,
    expires: null,
    servers: ['Meleys'],
    libraries: { Meleys: ['01. Movies'] },
    entitled: { Meleys: ['01. Movies'] },
    subscribed: true,
    payment_state: null,
    invited_at: null,
    customer_id: null,
    stripe_email: null,
  }

  it('leaves a member with an empty share map alone', () => {
    expect(withPlexAccess({ members: [member], access: { 'a@x.com': {} } })).toEqual([member])
  })

  it('leaves everyone alone without an answer from plex.tv', () => {
    expect(withPlexAccess({ members: [member], access: null })).toEqual([member])
  })

  it('stamps the tag and lets a false downloads override win', () => {
    const [stamped] = withOverrides({
      members: [{ ...member, downloads: true }],
      tags: new Map([['a@x.com', 'vip']]),
      downloads: new Map([['a@x.com', false]]),
    })
    expect(stamped?.tag ?? null).toBe('vip')
    expect(stamped?.downloads ?? null).toBe(false)
  })
})

describe('assembleMembers', () => {
  it('unions a pending customer and leaves out one claimed as a stripe address', () => {
    const members = assembleMembers({
      users: [{ id: 3, username: 'nora', email: 'nora@x.com', server: 'Meleys' }],
      libraries: LIBRARIES,
      invitations: [{ id: 1, code: 'INV1', used_by: '<User 3>' }],
      customers: new Map([
        ['stripe-only@x.com', row({ invite_code: 'INV1' })],
        ['pending@x.com', row({ customer_id: null })],
      ]),
      links: new Map(),
    })
    expect(members.map((m) => [m.email, m.stripe_email])).toEqual([
      ['nora@x.com', 'stripe-only@x.com'],
      ['pending@x.com', null],
    ])
  })
})
