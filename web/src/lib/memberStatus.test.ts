import { expect, test } from 'vitest'
import type { Member } from '@/lib/adminApi'
import { deriveStatus } from '@/lib/memberStatus'

const DAY_MS = 24 * 60 * 60 * 1000

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  subscribed: false,
  invited_at: null,
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

test('an unredeemed invite inside the 14-day grace period is Invited', () => {
  const invitedAt = new Date(Date.now() - 13 * DAY_MS).toISOString()
  const member = makeMember({ servers: [], invited_at: invitedAt })
  expect(deriveStatus({ member })).toBe('Invited')
})

test('an unredeemed invite older than the 14-day grace period is Declined Invite', () => {
  const invitedAt = new Date(Date.now() - 15 * DAY_MS).toISOString()
  const member = makeMember({ servers: [], invited_at: invitedAt })
  expect(deriveStatus({ member })).toBe('Declined Invite')
})

test('a stale invite stamp does not override real access', () => {
  const invitedAt = new Date(Date.now() - 40 * DAY_MS).toISOString()
  const member = makeMember({
    expires: '2099-01-01T00:00:00+00:00',
    subscribed: true,
    invited_at: invitedAt,
  })
  expect(deriveStatus({ member })).toBe('Subscribed Monthly')
})

test('a legacy share with servers but no subscription is Uninvited', () => {
  const member = makeMember({ servers: ['Meleys', 'Vhagar'] })
  expect(deriveStatus({ member })).toBe('Uninvited')
})

test('a legacy share with a fresh outstanding invite is Invited', () => {
  const invitedAt = new Date(Date.now() - 2 * DAY_MS).toISOString()
  const member = makeMember({ servers: ['Meleys'], invited_at: invitedAt })
  expect(deriveStatus({ member })).toBe('Invited')
})
