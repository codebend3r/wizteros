import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, filterSelf, parseArgs, renderReport, resolveSelf } from './cohorts.mjs'
import { readLedger } from './ledger.mjs'

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

test('--record requires an email address', () => {
  assert.throws(() => parseArgs({ argv: ['--record'] }), /--record requires an email address/i)
})

test('--record requires a play', () => {
  assert.throws(
    () => parseArgs({ argv: ['--record', 'a@example.com'] }),
    /--record requires a play/i,
  )
})

test('--record rejects an unrecognized play', () => {
  assert.throws(() => parseArgs({ argv: ['--record', 'a@example.com', 'upsell'] }), /unknown play/i)
})

test('opt-out takes an email', () => {
  assert.equal(parseArgs({ argv: ['--opt-out', 'a@example.com'] }).optOut, 'a@example.com')
})

test('--opt-out requires an email address', () => {
  assert.throws(() => parseArgs({ argv: ['--opt-out'] }), /--opt-out requires an email address/i)
})

test('--opt-out rejects a flag shaped value instead of opting out "--json"', () => {
  assert.throws(() => parseArgs({ argv: ['--opt-out', '--json'] }), /got the flag "--json"/)
})

test('--record rejects a flag shaped email and a flag shaped play', () => {
  assert.throws(
    () => parseArgs({ argv: ['--record', '--json', 'declined'] }),
    /got the flag "--json"/,
  )
  assert.throws(
    () => parseArgs({ argv: ['--record', 'a@example.com', '--json'] }),
    /got the flag "--json"/,
  )
})

test('--all is gone and is rejected like any other unknown flag', () => {
  assert.throws(() => parseArgs({ argv: ['--all'] }), /unknown flag/i)
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
    ledger: {
      'recent@example.com': { contacts: [{ at: daysAgo(2), play: 'declined' }], optedOut: false },
    },
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
    members: [
      member({
        email: 'card@example.com',
        subscribed: true,
        stripeStatus: 'past_due',
        expires: daysAgo(1),
      }),
    ],
    ledger: {},
    now: NOW,
    play: null,
  })
  assert.equal(report.triage.length, 1)
  assert.equal(
    report.plays.every((entry) => entry.leads.length === 0),
    true,
  )
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
  const text = renderReport({
    report: buildReport({ members: [], ledger: {}, now: NOW, play: null }),
  })
  assert.match(text, /nothing to send/i)
})

test('a play can be backfill', () => {
  assert.equal(parseArgs({ argv: ['--play=backfill'] }).play, 'backfill')
})

test('record accepts backfill as a play', () => {
  const args = parseArgs({ argv: ['--record', 'a@example.com', 'backfill'] })
  assert.deepEqual(args.record, { email: 'a@example.com', play: 'backfill' })
})

test('a backfill member appears in the backfill play, never in declined', () => {
  const bulkMembers = Array.from({ length: 10 }, (_, i) =>
    member({ email: `bulk${i}@example.com`, invitedAt: daysAgo(20) }),
  )
  const report = buildReport({ members: bulkMembers, ledger: {}, now: NOW, play: null })
  const backfill = report.plays.find((entry) => entry.play === 'backfill')
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.equal(backfill.cohortSize, 10)
  assert.equal(declined.cohortSize, 0)
})

test('the play blocks come back in warmth order: lapsed, backfill, declined', () => {
  const report = buildReport({ members: [], ledger: {}, now: NOW, play: null })
  assert.deepEqual(
    report.plays.map((entry) => entry.play),
    ['lapsed', 'backfill', 'declined'],
  )
})

test('the detected bulk dates are reported, so a backfill block names its migration', () => {
  const bulkDay = daysAgo(20).slice(0, 10)
  const bulkMembers = Array.from({ length: 10 }, (_, i) =>
    member({ email: `bulk${i}@example.com`, invitedAt: daysAgo(20) }),
  )
  const report = buildReport({ members: bulkMembers, ledger: {}, now: NOW, play: null })
  assert.deepEqual(report.bulkDates, [bulkDay])
  assert.match(renderReport({ report }), new RegExp(`BULK DATES.*${bulkDay}`))
})

test('two bulk dates are both reported, never collapsed into one migration', () => {
  const first = daysAgo(40).slice(0, 10)
  const second = daysAgo(20).slice(0, 10)
  const members = [
    ...Array.from({ length: 10 }, (_, i) =>
      member({ email: `a${i}@example.com`, invitedAt: daysAgo(40) }),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      member({ email: `b${i}@example.com`, invitedAt: daysAgo(20) }),
    ),
  ]
  const report = buildReport({ members, ledger: {}, now: NOW, play: null })
  assert.deepEqual(report.bulkDates, [first, second])
  assert.equal(report.plays.find((entry) => entry.play === 'backfill').cohortSize, 20)
})

test('bulk detection runs after the self filter, so an operator address can drop a date under the threshold', () => {
  const members = [
    ...Array.from({ length: 9 }, (_, i) =>
      member({ email: `bulk${i}@example.com`, invitedAt: daysAgo(20) }),
    ),
    member({ email: 'me+migration@example.com', invitedAt: daysAgo(20) }),
  ]
  const unfiltered = buildReport({ members, ledger: {}, now: NOW, play: null, selfAddresses: [] })
  assert.equal(unfiltered.plays.find((entry) => entry.play === 'backfill').cohortSize, 10)
  const filtered = buildReport({
    members,
    ledger: {},
    now: NOW,
    play: null,
    selfAddresses: ['me@example.com'],
  })
  assert.deepEqual(filtered.bulkDates, [])
  assert.equal(filtered.plays.find((entry) => entry.play === 'backfill').cohortSize, 0)
  assert.equal(filtered.plays.find((entry) => entry.play === 'declined').cohortSize, 9)
})

test('the nothing-to-send footer is withheld while triage still names real people', () => {
  const report = buildReport({
    members: [member({ email: 'ghost@example.com' })],
    ledger: {},
    now: NOW,
    play: null,
  })
  const text = renderReport({ report })
  assert.match(text, /TRIAGE/)
  assert.doesNotMatch(text, /nothing to send/i)
})

test('a gather run writes nothing: reading and rendering leave the state directory untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-state-'))
  try {
    assert.deepEqual(readdirSync(dir), [])
    const report = buildReport({
      members: [
        member({ email: 'a@example.com', invitedAt: daysAgo(30) }),
        member({ email: 'b@example.com', subscribed: true, stripeStatus: 'canceled' }),
        member({ email: 'c@example.com' }),
      ],
      ledger: readLedger({ dir }),
      now: NOW,
      play: null,
    })
    renderReport({ report })
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSelf prefers WZ_SALES_SELF, comma separated', () => {
  const result = resolveSelf({
    envValue: 'a@example.com, b@example.com',
    gitEmail: 'c@example.com',
  })
  assert.equal(result.source, 'WZ_SALES_SELF')
  assert.deepEqual(result.addresses, ['a@example.com', 'b@example.com'])
})

test('resolveSelf falls back to git config user.email', () => {
  const result = resolveSelf({ envValue: null, gitEmail: 'c@example.com' })
  assert.equal(result.source, 'git config user.email')
  assert.deepEqual(result.addresses, ['c@example.com'])
})

test('resolveSelf resolves nothing when neither source is available', () => {
  const result = resolveSelf({ envValue: null, gitEmail: null })
  assert.equal(result.source, 'none')
  assert.deepEqual(result.addresses, [])
})

test('filterSelf removes a plus tagged variant of the operator address and keeps others', () => {
  const members = [
    member({ email: 'me+gold@example.com' }),
    member({ email: 'someone@example.com' }),
  ]
  const { kept, filtered } = filterSelf({ members, selfAddresses: ['me@example.com'] })
  assert.deepEqual(
    kept.map((m) => m.email),
    ['someone@example.com'],
  )
  assert.deepEqual(
    filtered.map((m) => m.email),
    ['me+gold@example.com'],
  )
})

test('the self address filter removes a plus tagged variant and leaves an unrelated address', () => {
  const report = buildReport({
    members: [
      member({ email: 'me+gold@example.com', invitedAt: daysAgo(30) }),
      member({ email: 'someone@example.com', invitedAt: daysAgo(30) }),
    ],
    ledger: {},
    now: NOW,
    play: 'declined',
    selfAddresses: ['me@example.com'],
  })
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.deepEqual(
    declined.leads.map((lead) => lead.email),
    ['someone@example.com'],
  )
})

test('the filter is off and filters nothing when no operator address can be resolved', () => {
  const report = buildReport({
    members: [member({ email: 'me+gold@example.com', invitedAt: daysAgo(30) })],
    ledger: {},
    now: NOW,
    play: 'declined',
    selfAddresses: [],
  })
  const declined = report.plays.find((entry) => entry.play === 'declined')
  assert.equal(declined.cohortSize, 1)
  assert.deepEqual(report.selfFiltered, [])
})

test('a filtered address is reported on the report, not silently dropped', () => {
  const report = buildReport({
    members: [member({ email: 'me+test@example.com', invitedAt: daysAgo(30) })],
    ledger: {},
    now: NOW,
    play: 'declined',
    selfAddresses: ['me@example.com'],
  })
  assert.deepEqual(report.selfFiltered, ['me+test@example.com'])
})
