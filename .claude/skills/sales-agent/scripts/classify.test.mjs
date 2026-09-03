import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BULK_INVITE_THRESHOLD,
  INVITE_GRACE_DAYS,
  WARMTH,
  assignCohort,
  bulkInviteDates,
  rankLeads,
} from './classify.mjs'

const INVITE_RULES = new URL(
  '../../../../apps/admin-portal/src/lib/inviteRules.ts',
  import.meta.url,
)

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

test('the grace period matches the admin UI, read from inviteRules.ts', () => {
  const source = readFileSync(INVITE_RULES, 'utf8')
  const declared = source.match(/export const INVITE_GRACE_DAYS\s*=\s*(\d+)/)
  assert.ok(declared, `INVITE_GRACE_DAYS not found in ${INVITE_RULES.pathname}`)
  assert.equal(INVITE_GRACE_DAYS, Number(declared[1]))
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

test('a VIP with a failed card is still VIP, not triage-billing', () => {
  const m = member({ tag: 'vip', stripeStatus: 'past_due' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'vip')
})

test('a VIP with a canceled subscription is still VIP, not lapsed', () => {
  const m = member({ tag: 'vip', stripeStatus: 'canceled' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'vip')
})

test('an unparseable expires does not silently make a subscriber lapsed', () => {
  const m = member({ subscribed: true, expires: 'not-a-date', stripeStatus: 'active' })
  assert.equal(assignCohort({ member: m, now: NOW }), 'active')
})

test('WARMTH ranks lapsed above backfill above declined', () => {
  assert.deepEqual(
    Object.keys(WARMTH).sort((a, b) => WARMTH[b] - WARMTH[a]),
    ['lapsed', 'backfill', 'declined'],
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
    { email: 'b@example.com', cohort: 'declined', lastEventAt: daysAgo(10) },
  ]
  rankLeads({ leads })
  assert.equal(leads[0].email, 'a@example.com')
})

test('bulkInviteDates flags a date reached by the threshold and omits one short of it', () => {
  const bulkDay = daysAgo(20).slice(0, 10)
  const quietDay = daysAgo(21).slice(0, 10)
  const bulkMembers = Array.from({ length: BULK_INVITE_THRESHOLD }, (_, i) =>
    member({ email: `bulk${i}@example.com`, invitedAt: daysAgo(20) }),
  )
  const quietMembers = Array.from({ length: BULK_INVITE_THRESHOLD - 1 }, (_, i) =>
    member({ email: `quiet${i}@example.com`, invitedAt: daysAgo(21) }),
  )
  const dates = bulkInviteDates({ members: [...bulkMembers, ...quietMembers] })
  assert.equal(dates.has(bulkDay), true)
  assert.equal(dates.has(quietDay), false)
})

test('bulkInviteDates counts distinct members, not rows, so duplicates cannot manufacture a bulk date', () => {
  const day = daysAgo(5).slice(0, 10)
  const duplicateRows = Array.from({ length: BULK_INVITE_THRESHOLD }, () =>
    member({ email: 'dup@example.com', invitedAt: daysAgo(5) }),
  )
  const dates = bulkInviteDates({ members: duplicateRows })
  assert.equal(dates.has(day), false)
})

test('a member past the grace whose invite date is a bulk date is backfill', () => {
  const bulkDates = new Set([daysAgo(20).slice(0, 10)])
  const m = member({ invitedAt: daysAgo(20) })
  assert.equal(assignCohort({ member: m, now: NOW, bulkDates }), 'backfill')
})

test('a member past the grace whose invite date is not a bulk date is still declined', () => {
  const bulkDates = new Set([daysAgo(20).slice(0, 10)])
  const m = member({ invitedAt: daysAgo(30) })
  assert.equal(assignCohort({ member: m, now: NOW, bulkDates }), 'declined')
})

test('a member inside the grace on a bulk date is still invited-pending', () => {
  const day = daysAgo(5).slice(0, 10)
  const bulkDates = new Set([day])
  const m = member({ invitedAt: daysAgo(5) })
  assert.equal(assignCohort({ member: m, now: NOW, bulkDates }), 'invited-pending')
})

test('a VIP on a bulk date is still vip', () => {
  const day = daysAgo(20).slice(0, 10)
  const bulkDates = new Set([day])
  const m = member({ tag: 'vip', invitedAt: daysAgo(20) })
  assert.equal(assignCohort({ member: m, now: NOW, bulkDates }), 'vip')
})

test('a subscribed member on a bulk date is still active', () => {
  const day = daysAgo(20).slice(0, 10)
  const bulkDates = new Set([day])
  const m = member({
    subscribed: true,
    expires: inDays(20),
    stripeStatus: 'active',
    invitedAt: daysAgo(20),
  })
  assert.equal(assignCohort({ member: m, now: NOW, bulkDates }), 'active')
})

test('rankLeads orders one play by recency alone, the only input it is ever given', () => {
  const leads = [
    { email: 'middle@example.com', cohort: 'backfill', lastEventAt: daysAgo(30) },
    { email: 'oldest@example.com', cohort: 'backfill', lastEventAt: daysAgo(300) },
    { email: 'newest@example.com', cohort: 'backfill', lastEventAt: daysAgo(2) },
  ]
  assert.deepEqual(
    rankLeads({ leads }).map((lead) => lead.email),
    ['newest@example.com', 'middle@example.com', 'oldest@example.com'],
  )
})
