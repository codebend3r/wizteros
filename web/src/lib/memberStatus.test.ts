import { expect, test } from 'vitest'
import type { Member } from '@/lib/adminApi'
import { deriveStatus } from '@/lib/memberStatus'

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  subscribed: false,
  ...overrides,
})

test('a member whose expiry has passed is an Expired Member', () => {
  const member = makeMember({ expires: '2020-01-01T00:00:00+00:00', subscribed: true })
  expect(deriveStatus({ member })).toBe('Expired Member')
})

test('a subscribed member with a future expiry is Subscribed Monthly', () => {
  const member = makeMember({ expires: '2099-01-01T00:00:00+00:00', subscribed: true })
  expect(deriveStatus({ member })).toBe('Subscribed Monthly')
})

test('a member on no servers yet is Invited', () => {
  const member = makeMember({ servers: [] })
  expect(deriveStatus({ member })).toBe('Invited')
})

test('a legacy share with servers but no subscription is Uninvited', () => {
  const member = makeMember({ servers: ['Meleys', 'Vhagar'] })
  expect(deriveStatus({ member })).toBe('Uninvited')
})
