import { expect, test } from '@/test/vi'
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
  entitled: {},
  subscribed: false,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: null,
  stripe_email: null,
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

test('a member with no payment and no invite on record is Uninvited', () => {
  const member = makeMember({ servers: [] })
  expect(deriveStatus({ member })).toBe('Uninvited')
})

test('an unpaid member with a fresh invite and a future expiry is Invited', () => {
  // The core decoupling: a manual 14-day access deadline (expiry) plus a fresh
  // invite reads "Invited", not "Subscribed Monthly", because there is no payment.
  const invitedAt = new Date(Date.now() - 1 * DAY_MS).toISOString()
  const member = makeMember({
    servers: ['Meleys'],
    expires: '2099-01-01T00:00:00+00:00',
    subscribed: false,
    invited_at: invitedAt,
  })
  expect(deriveStatus({ member })).toBe('Invited')
})

test('an unpaid invite whose expiry lapsed is Declined Invite, not Expired Member', () => {
  const invitedAt = new Date(Date.now() - 15 * DAY_MS).toISOString()
  const member = makeMember({
    servers: ['Meleys'],
    expires: '2020-01-01T00:00:00+00:00',
    subscribed: false,
    invited_at: invitedAt,
  })
  expect(deriveStatus({ member })).toBe('Declined Invite')
})

test('a future expiry alone does not make an unpaid member Subscribed Monthly', () => {
  const member = makeMember({ expires: '2099-01-01T00:00:00+00:00', subscribed: false })
  expect(deriveStatus({ member })).toBe('Uninvited')
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

test('a banned tag outranks everything, VIP and a live subscription included', () => {
  const member = makeMember({
    expires: '2099-01-01T00:00:00+00:00',
    subscribed: true,
    tag: 'banned',
  })
  expect(deriveStatus({ member })).toBe('Banned')
})

test('a vip tag overrides every derived status', () => {
  const member = makeMember({ expires: '2020-01-01T00:00:00+00:00', subscribed: true, tag: 'vip' })
  expect(deriveStatus({ member })).toBe('VIP')
})

test('an hvu tag is administrative and does not override the lifecycle status', () => {
  const subscribed = makeMember({
    expires: '2099-01-01T00:00:00+00:00',
    subscribed: true,
    tag: 'hvu',
  })
  expect(deriveStatus({ member: subscribed })).toBe('Subscribed Monthly')

  const invitedAt = new Date(Date.now() - 1 * DAY_MS).toISOString()
  const invited = makeMember({ servers: [], invited_at: invitedAt, tag: 'hvu' })
  expect(deriveStatus({ member: invited })).toBe('Invited')
})

test('a subscriber with a failed charge reads as Payment Failed, not Subscribed', () => {
  // The gap that let a paying member lapse unnoticed: Stripe spent weeks
  // retrying a declined charge while the admin UI called them healthy.
  const member = makeMember({ subscribed: true, payment_state: 'past_due' })
  expect(deriveStatus({ member })).toBe('Payment Failed')
})

test('a member in dunning whose window already lapsed still reads as Expired', () => {
  // Expiry is the harder fact: they cannot watch anything, so the dunning
  // label must not soften it.
  const member = makeMember({
    subscribed: true,
    payment_state: 'past_due',
    expires: '2020-01-01T00:00:00+00:00',
  })
  expect(deriveStatus({ member })).toBe('Expired Member')
})

test('a VIP is never relabelled by a failed charge', () => {
  const member = makeMember({ subscribed: true, payment_state: 'past_due', tag: 'vip' })
  expect(deriveStatus({ member })).toBe('VIP')
})

test('clearing the dunning flag returns a member to Subscribed Monthly', () => {
  const member = makeMember({ subscribed: true, payment_state: null })
  expect(deriveStatus({ member })).toBe('Subscribed Monthly')
})
