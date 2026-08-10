import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinMembers, peopleFrom, requireConfig, stripeByEmail } from './sources.mjs'

test('requireConfig names every missing variable at once', () => {
  assert.throws(
    () => requireConfig({ env: {} }),
    /STRIPE_API_KEY.*WIZARR_BASE_URL.*WIZARR_API_KEY/s,
  )
})

test('requireConfig treats an empty string as missing', () => {
  assert.throws(
    () => requireConfig({ env: { STRIPE_API_KEY: '', WIZARR_BASE_URL: 'x', WIZARR_API_KEY: 'y' } }),
    /STRIPE_API_KEY/,
  )
})

test('requireConfig strips a trailing slash from the Wizarr base', () => {
  const config = requireConfig({
    env: { STRIPE_API_KEY: 'sk', WIZARR_BASE_URL: 'http://nas:5690/', WIZARR_API_KEY: 'k' },
  })
  assert.equal(config.wizarrBase, 'http://nas:5690')
})

test('peopleFrom collapses one person with records on several servers', () => {
  const people = peopleFrom({
    users: [
      { email: 'A@Example.com', username: 'alex', expires: '2026-09-01T00:00:00Z' },
      { email: 'a@example.com', username: 'alex', expires: '2026-10-01T00:00:00Z' },
    ],
  })
  assert.equal(people.length, 1)
  assert.equal(people[0].email, 'a@example.com')
})

test('peopleFrom keeps unlimited access as the winning expiry', () => {
  const people = peopleFrom({
    users: [
      { email: 'a@example.com', username: 'alex', expires: '2026-09-01T00:00:00Z' },
      { email: 'a@example.com', username: 'alex', expires: null },
    ],
  })
  assert.equal(people[0].expires, null)
})

test('peopleFrom falls back to the username when there is no email', () => {
  const people = peopleFrom({ users: [{ email: null, username: 'alex', expires: null }] })
  assert.equal(people[0].username, 'alex')
})

test('stripeByEmail keeps the paying status when a customer has two subscriptions', () => {
  const byEmail = stripeByEmail({
    subs: [
      { status: 'canceled', customer: { id: 'cus_1', email: 'a@example.com' } },
      { status: 'active', customer: { id: 'cus_1', email: 'A@example.com' } },
    ],
  })
  assert.equal(byEmail['a@example.com'].status, 'active')
})

test('joinMembers carries store flags onto the member', () => {
  const members = joinMembers({
    storeRows: [
      { email: 'a@example.com', tier: 'bronze', invited_at: '2026-07-01T00:00:00Z', subscribed: 1, tag: null, invite_code: null },
    ],
    people: [],
    stripe: {},
    invitations: [],
  })
  assert.equal(members.length, 1)
  assert.equal(members[0].subscribed, true)
  assert.equal(members[0].tier, 'bronze')
  assert.equal(members[0].invitedAt, '2026-07-01T00:00:00Z')
})

test('joinMembers attaches the Wizarr expiry to the matching store row', () => {
  const members = joinMembers({
    storeRows: [{ email: 'a@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: null }],
    people: [{ email: 'a@example.com', username: 'alex', expires: '2026-09-01T00:00:00Z' }],
    stripe: {},
    invitations: [],
  })
  assert.equal(members[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers matches through the invite code when the Plex email differs', () => {
  const members = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'ABC123' }],
    people: [{ email: 'plex@example.com', username: 'alex', expires: '2026-09-01T00:00:00Z' }],
    stripe: {},
    invitations: [{ code: 'ABC123', used_by: 'alex' }],
    })
  assert.equal(members.length, 1)
  assert.equal(members[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers attaches the Stripe status', () => {
  const members = joinMembers({
    storeRows: [{ email: 'a@example.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null }],
    people: [],
    stripe: { 'a@example.com': { status: 'canceled', customerId: 'cus_1' } },
    invitations: [],
  })
  assert.equal(members[0].stripeStatus, 'canceled')
})

test('joinMembers reads the vip tag', () => {
  const members = joinMembers({
    storeRows: [{ email: 'a@example.com', tier: null, invited_at: null, subscribed: 1, tag: 'vip', invite_code: null }],
    people: [],
    stripe: {},
    invitations: [],
  })
  assert.equal(members[0].tag, 'vip')
})
