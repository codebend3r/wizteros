import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinMembers, peopleFrom, requireConfig, stripeByEmail, wizarrList } from './sources.mjs'

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

test('wizarrList unwraps a users envelope', () => {
  const list = wizarrList({ body: { users: [{ id: 1 }, { id: 2 }], count: 2 }, key: 'users', path: '/api/users' })
  assert.deepEqual(list, [{ id: 1 }, { id: 2 }])
})

test('wizarrList unwraps an invitations envelope', () => {
  const list = wizarrList({
    body: { invitations: [{ code: 'ABC' }], count: 1 },
    key: 'invitations',
    path: '/api/invitations',
  })
  assert.deepEqual(list, [{ code: 'ABC' }])
})

test('wizarrList yields an empty array for a missing or unexpected top-level key', () => {
  assert.deepEqual(wizarrList({ body: {}, key: 'users', path: '/api/users' }), [])
  assert.deepEqual(wizarrList({ body: { count: 0 }, key: 'users', path: '/api/users' }), [])
})

test('wizarrList throws a diagnosable error when the key holds something other than a list', () => {
  assert.throws(
    () => wizarrList({ body: { users: 'nope' }, key: 'users', path: '/api/users' }),
    /\/api\/users.*users.*array/s,
  )
})

test('joinMembers matches the invite-code fallback by the id inside a Python repr', () => {
  const members = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'ABC123' }],
    people: [{ email: 'plex@example.com', username: 'amols7', expires: '2026-09-01T00:00:00Z', ids: [277] }],
    stripe: {},
    invitations: [{ code: 'ABC123', used_by: '<User 277>' }],
  })
  assert.equal(members[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers yields no match, and does not throw, when the repr id has no record', () => {
  const members = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'ABC123' }],
    people: [{ email: 'plex@example.com', username: 'amols7', expires: '2026-09-01T00:00:00Z', ids: [277] }],
    stripe: {},
    invitations: [{ code: 'ABC123', used_by: '<User 999>' }],
  })
  assert.equal(members.length, 1)
  assert.equal(members[0].expires, null)
})

test('joinMembers does not throw when used_by is null, absent, or a plain username, and the username still matches', () => {
  const base = {
    people: [{ email: 'plex@example.com', username: 'alex', expires: '2026-09-01T00:00:00Z', ids: [1] }],
    stripe: {},
  }
  const nullUsedBy = joinMembers({
    storeRows: [{ email: 'a@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE1' }],
    invitations: [{ code: 'CODE1', used_by: null }],
    ...base,
  })
  assert.equal(nullUsedBy[0].expires, null)

  const absentUsedBy = joinMembers({
    storeRows: [{ email: 'a@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE2' }],
    invitations: [{ code: 'CODE2' }],
    ...base,
  })
  assert.equal(absentUsedBy[0].expires, null)

  const usernameUsedBy = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE3' }],
    invitations: [{ code: 'CODE3', used_by: 'alex' }],
    ...base,
  })
  assert.equal(usernameUsedBy[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers reaches a person on several servers by any of their Wizarr ids', () => {
  const people = peopleFrom({
    users: [
      { id: 10, email: 'sam@example.com', username: 'sam', expires: '2026-09-01T00:00:00Z', server: 'Vermithor' },
      { id: 20, email: 'sam@example.com', username: 'sam', expires: null, server: 'Caraxes' },
    ],
  })
  const viaFirstId = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE4' }],
    people,
    stripe: {},
    invitations: [{ code: 'CODE4', used_by: '<User 10>' }],
  })
  assert.equal(viaFirstId[0].expires, null)

  const viaSecondId = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE5' }],
    people,
    stripe: {},
    invitations: [{ code: 'CODE5', used_by: '<User 20>' }],
  })
  assert.equal(viaSecondId[0].expires, null)
})

test('joinMembers takes the username path for used_by "amols7", never reading it as id 7', () => {
  const members = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE6' }],
    people: [
      { email: 'other@example.com', username: 'sevenoseven', expires: '2020-01-01T00:00:00Z', ids: [7] },
      { email: 'plex@example.com', username: 'amols7', expires: '2026-09-01T00:00:00Z', ids: [277] },
    ],
    stripe: {},
    invitations: [{ code: 'CODE6', used_by: 'amols7' }],
  })
  assert.equal(members[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers still matches "<User 277>" by id', () => {
  const members = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE7' }],
    people: [{ email: 'plex@example.com', username: 'amols7', expires: '2026-09-01T00:00:00Z', ids: [277] }],
    stripe: {},
    invitations: [{ code: 'CODE7', used_by: '<User 277>' }],
  })
  assert.equal(members[0].expires, '2026-09-01T00:00:00Z')
})

test('joinMembers yields no match for a shape that is neither a repr nor a username hit', () => {
  const people = [{ email: 'plex@example.com', username: 'amols7', expires: '2026-09-01T00:00:00Z', ids: [277] }]
  const noBrackets = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE8' }],
    people,
    stripe: {},
    invitations: [{ code: 'CODE8', used_by: 'User 277' }],
  })
  assert.equal(noBrackets.length, 1)
  assert.equal(noBrackets[0].expires, null)

  const wrongWord = joinMembers({
    storeRows: [{ email: 'billing@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: 'CODE9' }],
    people,
    stripe: {},
    invitations: [{ code: 'CODE9', used_by: '<Account 5>' }],
  })
  assert.equal(wrongWord.length, 1)
  assert.equal(wrongWord[0].expires, null)
})

test('joinMembers collapses four store rows for one email into a single member', () => {
  const storeRows = [
    { email: 'codebenderinc@gmail.com', tier: 'gold', invited_at: '2026-07-25T00:00:00Z', subscribed: 0, tag: null, invite_code: null },
    { email: 'codebenderinc@gmail.com', tier: 'gold', invited_at: '2026-07-25T00:00:00Z', subscribed: 0, tag: null, invite_code: null },
    { email: 'codebenderinc@gmail.com', tier: 'gold', invited_at: '2026-07-25T00:00:00Z', subscribed: 0, tag: null, invite_code: null },
    { email: 'codebenderinc@gmail.com', tier: 'gold', invited_at: '2026-07-25T00:00:00Z', subscribed: 0, tag: null, invite_code: null },
  ]
  const members = joinMembers({ storeRows, people: [], stripe: {}, invitations: [] })
  assert.equal(members.length, 1)
})

test('joinMembers ORs subscribed across duplicate rows, true on any row winning', () => {
  const storeRows = [
    { email: 'a@example.com', tier: null, invited_at: '2026-08-01T00:00:00Z', subscribed: 0, tag: null, invite_code: null },
    { email: 'a@example.com', tier: null, invited_at: null, subscribed: 1, tag: null, invite_code: null },
  ]
  const members = joinMembers({ storeRows, people: [], stripe: {}, invitations: [] })
  assert.equal(members.length, 1)
  assert.equal(members[0].subscribed, true)
})

test('joinMembers keeps tier and invite_code from the row with the most recent invited_at', () => {
  const storeRows = [
    { email: 'billing@example.com', tier: 'bronze', invited_at: '2026-07-01T00:00:00Z', subscribed: 0, tag: null, invite_code: 'OLD1' },
    { email: 'billing@example.com', tier: 'gold', invited_at: '2026-07-25T00:00:00Z', subscribed: 0, tag: null, invite_code: 'NEW1' },
  ]
  const members = joinMembers({
    storeRows,
    people: [{ email: 'plex@example.com', username: 'bob', expires: '2099-01-01T00:00:00Z', ids: [] }],
    stripe: {},
    invitations: [{ code: 'NEW1', used_by: 'bob' }],
  })
  assert.equal(members.length, 1)
  assert.equal(members[0].tier, 'gold')
  assert.equal(members[0].invitedAt, '2026-07-25T00:00:00Z')
  // invite_code follows the winning row: only NEW1 has a matching invitation, so
  // the expiry resolves through it. Had OLD1 leaked through instead, this would
  // stay null because no invitation redeems OLD1.
  assert.equal(members[0].expires, '2099-01-01T00:00:00Z')
})

test('joinMembers keeps a vip tag present on only one of several duplicate rows', () => {
  const storeRows = [
    { email: 'a@example.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null },
    { email: 'a@example.com', tier: null, invited_at: null, subscribed: 0, tag: 'vip', invite_code: null },
  ]
  const members = joinMembers({ storeRows, people: [], stripe: {}, invitations: [] })
  assert.equal(members.length, 1)
  assert.equal(members[0].tag, 'vip')
})

test('joinMembers does not merge rows for genuinely different emails', () => {
  const storeRows = [
    { email: 'a@example.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null },
    { email: 'b@example.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null },
  ]
  const members = joinMembers({ storeRows, people: [], stripe: {}, invitations: [] })
  assert.equal(members.length, 2)
})

test('joinMembers collapses rows whose emails differ only by case', () => {
  const storeRows = [
    { email: 'A@x.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null },
    { email: 'a@x.com', tier: null, invited_at: null, subscribed: 0, tag: null, invite_code: null },
  ]
  const members = joinMembers({ storeRows, people: [], stripe: {}, invitations: [] })
  assert.equal(members.length, 1)
  assert.equal(members[0].email, 'a@x.com')
})
