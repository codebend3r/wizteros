import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INVITE_GRACE_DAYS, assignCohort, rankLeads } from './classify.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-10T00:00:00Z')
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString()
const inDays = (n) => new Date(NOW + n * DAY).toISOString()

const member = (overrides) => ({
  email: 'a@example.com',
  tag: null,
  subscribed: false,
  invitedAt: null,
  expires: null,
  stripeStatus: null,
  tier: null,
  ...overrides,
})

test('the grace period matches the admin UI', () => {
  assert.equal(INVITE_GRACE_DAYS, 14)
})

test('a VIP is never in a sellable cohort', () => {
  const m = member({ tag: 'vip', subscribed: false, invitedAt: daysAgo(90) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'vip')
})

test('the hvu tag does not exclude anyone', () => {
  const m = member({ tag: 'hvu', invitedAt: daysAgo(90) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'declined')
})

test('a failed card is a billing problem, not a lead', () => {
  const m = member({ subscribed: true, stripeStatus: 'past_due', expires: daysAgo(2) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'triage-billing')
})

test('an unpaid subscription is also a billing problem', () => {
  const m = member({ subscribed: true, stripeStatus: 'unpaid', expires: daysAgo(2) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'triage-billing')
})

test('a deliberate cancel is lapsed even though the webhook cleared subscribed', () => {
  const m = member({ subscribed: false, stripeStatus: 'canceled', invitedAt: daysAgo(200) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'lapsed')
})

test('a subscriber whose access window has passed is lapsed', () => {
  const m = member({ subscribed: true, expires: daysAgo(3), stripeStatus: 'active' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'lapsed')
})

test('a current subscriber is left alone', () => {
  const m = member({ subscribed: true, expires: inDays(20), stripeStatus: 'active' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'active')
})

test('a subscriber with no expiry at all is current, not lapsed', () => {
  const m = member({ subscribed: true, expires: null, stripeStatus: 'active' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'active')
})

test('an invite past the grace period is declined', () => {
  const m = member({ invitedAt: daysAgo(15) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'declined')
})

test('an invite inside the grace period is still pending, not declined', () => {
  const m = member({ invitedAt: daysAgo(13) })
  assert.equal(assignCohort({ member: m, now: NOW }), 'invited-pending')
})

test('no payment and no invite is uninvited', () => {
  assert.equal(assignCohort({ member: member({}), now: NOW }), 'uninvited')
})

test('an unparseable invited_at does not silently become declined', () => {
  const m = member({ invitedAt: 'not-a-date' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'uninvited')
})

test('ranking puts a lapsed member above a declined one', () => {
  const leads = [
    { email: 'declined@example.com', cohort: 'declined', lastEventAt: daysAgo(1) },
    { email: 'lapsed@example.com', cohort: 'lapsed', lastEventAt: daysAgo(200) },
  ]
  assert.deepEqual(
    rankLeads({ leads }).map((lead) => lead.email),
    ['lapsed@example.com', 'declined@example.com'],
  )
})

test('within one cohort the more recent event ranks first', () => {
  const leads = [
    { email: 'old@example.com', cohort: 'declined', lastEventAt: daysAgo(300) },
    { email: 'recent@example.com', cohort: 'declined', lastEventAt: daysAgo(20) },
  ]
  assert.deepEqual(
    rankLeads({ leads }).map((lead) => lead.email),
    ['recent@example.com', 'old@example.com'],
  )
})

test('ranking does not mutate its input', () => {
  const leads = [
    { email: 'a@example.com', cohort: 'declined', lastEventAt: daysAgo(300) },
    { email: 'b@example.com', cohort: 'lapsed', lastEventAt: daysAgo(10) },
  ]
  rankLeads({ leads })
  assert.equal(leads[0].email, 'a@example.com')
})
