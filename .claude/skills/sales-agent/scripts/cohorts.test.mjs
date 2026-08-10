import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, parseArgs, renderReport } from './cohorts.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-10T00:00:00Z')
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString()

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

test('no flags means all plays', () => {
  assert.deepEqual(parseArgs({ argv: [] }).play, null)
})

test('a play can be selected', () => {
  assert.equal(parseArgs({ argv: ['--play=lapsed'] }).play, 'lapsed')
})

test('an unknown play is rejected rather than guessed at', () => {
  assert.throws(() => parseArgs({ argv: ['--play=upsell'] }), /unknown play/i)
})

test('an unknown flag is rejected rather than ignored', () => {
  assert.throws(() => parseArgs({ argv: ['--send'] }), /unknown flag/i)
})

test('record takes an email and a play', () => {
  const args = parseArgs({ argv: ['--record', 'a@example.com', 'declined'] })
  assert.deepEqual(args.record, { email: 'a@example.com', play: 'declined' })
})

test('opt-out takes an email', () => {
  assert.equal(parseArgs({ argv: ['--opt-out', 'a@example.com'] }).optOut, 'a@example.com')
})

test('a VIP never reaches a play, whatever their other fields say', () => {
  const report = buildReport({
    members: [member({ email: 'vip@example.com', tag: 'vip', invitedAt: daysAgo(90) })],
    ledger: {},
    now: NOW,
    play: null,
  })
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.equal(declined.leads.length, 0)
  assert.equal(declined.cohortSize, 0)
})

test('a suppressed person is counted as excluded, never dropped', () => {
  const report = buildReport({
    members: [
      member({ email: 'fresh@example.com', invitedAt: daysAgo(30) }),
      member({ email: 'recent@example.com', invitedAt: daysAgo(30) }),
    ],
    ledger: { 'recent@example.com': { contacts: [{ at: daysAgo(2), play: 'declined' }], optedOut: false } },
    now: NOW,
    play: 'declined',
  })
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.equal(declined.cohortSize, 2)
  assert.equal(declined.leads.length, 1)
  assert.equal(declined.excluded.length, 1)
  assert.equal(declined.excluded[0].reason, 'cooldown')
})

test('contactable plus excluded always reconciles with the cohort size', () => {
  const members = [
    member({ email: 'a@example.com', invitedAt: daysAgo(30) }),
    member({ email: 'b@example.com', invitedAt: daysAgo(30) }),
    member({ email: 'c@example.com', invitedAt: daysAgo(30) }),
  ]
  const report = buildReport({
    members,
    ledger: { 'b@example.com': { contacts: [], optedOut: true } },
    now: NOW,
    play: 'declined',
  })
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.equal(declined.leads.length + declined.excluded.length, declined.cohortSize)
})

test('billing failures land in triage and never in a play', () => {
  const report = buildReport({
    members: [member({ email: 'card@example.com', subscribed: true, stripeStatus: 'past_due', expires: daysAgo(1) })],
    ledger: {},
    now: NOW,
    play: null,
  })
  assert.equal(report.triage.length, 1)
  assert.equal(report.plays.every((entry) => entry.leads.length === 0), true)
})

test('uninvited people are listed for triage, never drafted for', () => {
  const report = buildReport({
    members: [member({ email: 'ghost@example.com' })],
    ledger: {},
    now: NOW,
    play: 'uninvited',
  })
  const uninvited = report.plays.find((entry) => entry.play === 'uninvited')
  assert.equal(uninvited, undefined)
  assert.equal(report.triage.length, 1)
})

test('the rendered report names the excluded reasons', () => {
  const report = buildReport({
    members: [member({ email: 'a@example.com', invitedAt: daysAgo(30) })],
    ledger: { 'a@example.com': { contacts: [], optedOut: true } },
    now: NOW,
    play: 'declined',
  })
  const text = renderReport({ report })
  assert.match(text, /EXCLUDED/)
  assert.match(text, /opted-out/)
})

test('an empty result renders as a real answer, not a blank page', () => {
  const text = renderReport({ report: buildReport({ members: [], ledger: {}, now: NOW, play: null }) })
  assert.match(text, /nothing to send/i)
})
