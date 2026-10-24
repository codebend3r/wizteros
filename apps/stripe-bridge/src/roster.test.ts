// The roster's pure functions on their own. The admin route tests reach them
// too (see admin/adminController.test.ts); these pin the ordering and
// empty-value details a route test would only catch by accident.

import { describe, expect, it } from 'vitest'
import {
  assembleMembers,
  dedupeMembers,
  memberFromCustomer,
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

describe('dedupeMembers', () => {
  it('keeps username-only local accounts without inventing an email', () => {
    const members = dedupeMembers({
      users: [{ id: 9, username: 'local', email: null, server: 'Meleys' }],
      customers: new Map(),
      libraries: LIBRARIES,
    })
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ email: '', member: 'local', servers: ['Meleys'] })
  })

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
      row: row({ tier: 'youth' }),
      libraries: LIBRARIES,
    })
    expect(member.member).toBe('max')
    expect(member.tier).toBe('youth')
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
  it.each([false, true])(
    'keeps all payers in one identity independent of insertion order (%s)',
    (reverse) => {
      const customers = [
        ['first@x.com', row({ customer_id: 'cus_first', subscribed: false })],
        ['second@x.com', row({ customer_id: 'cus_second', tier: 'gold' })],
      ] as const
      const members = assembleMembers({
        users: [{ id: 3, username: 'nora', email: 'nora@x.com', server: 'Meleys' }],
        libraries: LIBRARIES,
        invitations: [],
        customers: new Map(reverse ? customers.toReversed() : customers),
        links: new Map([
          ['first@x.com', 'nora@x.com'],
          ['second@x.com', 'nora@x.com'],
        ]),
        finishing: {
          access: null,
          tags: new Map([['first@x.com', 'banned']]),
          downloads: new Map(),
        },
      })
      expect(members).toHaveLength(1)
      expect(members[0]).toMatchObject({
        email: 'nora@x.com',
        tag: 'banned',
        stripe_email: 'second@x.com',
        tier: 'gold',
      })
    },
  )

  it('collapses manually linked pending accounts before either redeems', () => {
    const members = assembleMembers({
      users: [],
      libraries: LIBRARIES,
      invitations: [],
      customers: new Map([
        ['first@x.com', row()],
        ['second@x.com', row()],
      ]),
      links: new Map([
        ['first@x.com', 'nora@x.com'],
        ['second@x.com', 'nora@x.com'],
      ]),
    })
    expect(members).toHaveLength(1)
    expect(members[0]?.email ?? null).toBe('nora@x.com')
  })

  it('uses canonical redeemed links with case-insensitive codes and manual precedence', () => {
    const members = assembleMembers({
      users: [
        { id: 1, username: 'nora', email: 'nora@x.com' },
        { id: 2, username: 'other', email: 'other@x.com' },
      ],
      libraries: LIBRARIES,
      invitations: [{ id: 1, code: 'INV1', used_by: '<User 2>' }],
      customers: new Map([['payer@x.com', row({ invite_code: 'inv1' })]]),
      links: new Map([['payer@x.com', 'nora@x.com']]),
    })
    expect(members).toHaveLength(2)
    expect(members.find((m) => m.email === 'nora@x.com')?.stripe_email ?? null).toBe('payer@x.com')
    expect(members.find((m) => m.email === 'other@x.com')?.stripe_email ?? null).toBeNull()
  })

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
