import { expect, test } from '@/test/vi'
import type { Member } from '@/lib/adminApi'
import { findDuplicateEmails } from '@/lib/duplicateMembers'

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'bronze',
  downloads: null,
  expires: null,
  servers: [],
  libraries: {},
  entitled: {},
  subscribed: true,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: null,
  stripe_email: null,
  ...overrides,
})

test('flags two subscribers one typed character apart', () => {
  // The real pair: a declined charge, then a re-subscribe under a re-typed
  // address, leaving two live Stripe customers for one person.
  const members = [
    makeMember({ email: 'jimmyvo767@gmail.com' }),
    makeMember({ email: 'jimmyvo768@gmail.com' }),
    makeMember({ email: 'someone@else.com' }),
  ]
  const flagged = findDuplicateEmails({ members })
  expect(flagged.has('jimmyvo767@gmail.com')).toBe(true)
  expect(flagged.has('jimmyvo768@gmail.com')).toBe(true)
  expect(flagged.has('someone@else.com')).toBe(false)
})

test('flags the same gmail mailbox written with dots or a plus tag', () => {
  const members = [
    makeMember({ email: 'jim.vo+plex@gmail.com' }),
    makeMember({ email: 'jimvo@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(2)
})

test('an inserted or deleted character counts as one edit', () => {
  const members = [
    makeMember({ email: 'jimvo@gmail.com' }),
    makeMember({ email: 'jimmvo@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(2)
})

test('two edits apart is not a duplicate', () => {
  const members = [
    makeMember({ email: 'jimmyvo767@gmail.com' }),
    makeMember({ email: 'jimmyvo889@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(0)
})

test('different mailboxes at the same domain are left alone', () => {
  const members = [
    makeMember({ email: 'alice@gmail.com' }),
    makeMember({ email: 'bob@gmail.com' }),
    makeMember({ email: 'carol@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(0)
})

test('only members with a payment signal are compared', () => {
  // Declined and uninvited rows are mostly addresses that never became
  // anyone; pairing them trains the reader to ignore the badge.
  const members = [
    makeMember({ email: 'jimmyvo767@gmail.com', subscribed: false }),
    makeMember({ email: 'jimmyvo768@gmail.com', subscribed: false }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(0)
})

test('a VIP counts as a payment signal', () => {
  const members = [
    makeMember({ email: 'jimmyvo767@gmail.com', subscribed: false, tag: 'vip' }),
    makeMember({ email: 'jimmyvo768@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(2)
})

test('a member in dunning is still compared', () => {
  // This is exactly the pair worth catching: the failed one and its retry.
  const members = [
    makeMember({ email: 'jimmyvo767@gmail.com', payment_state: 'past_due' }),
    makeMember({ email: 'jimmyvo768@gmail.com' }),
  ]
  expect(findDuplicateEmails({ members }).size).toBe(2)
})

test('an empty list and a single member produce nothing', () => {
  expect(findDuplicateEmails({ members: [] }).size).toBe(0)
  expect(findDuplicateEmails({ members: [makeMember({})] }).size).toBe(0)
})
