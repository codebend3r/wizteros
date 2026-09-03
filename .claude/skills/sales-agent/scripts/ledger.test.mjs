import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COOLDOWN_DAYS,
  LIFETIME_CAP,
  optOut,
  readLedger,
  recordContact,
  stateDir,
  suppression,
  writeLedger,
} from './ledger.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-10T00:00:00Z')
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString()

test('stateDir prefers WZ_SALES_STATE', () => {
  const dir = stateDir({ env: { WZ_SALES_STATE: '/custom/place', HOME: '/home/x' } })
  assert.equal(dir, '/custom/place')
})

test('stateDir falls back to a path under HOME and never inside a repo', () => {
  const dir = stateDir({ env: { HOME: '/home/x' } })
  assert.equal(dir, '/home/x/.local/state/wizteros/sales-agent')
})

test('stateDir throws rather than returning a relative path when neither source resolves', () => {
  assert.throws(() => stateDir({ env: {} }), /WZ_SALES_STATE or HOME/)
  assert.throws(() => stateDir({ env: { HOME: '' } }), /WZ_SALES_STATE or HOME/)
})

test('readLedger returns an empty object when the file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-ledger-'))
  try {
    assert.deepEqual(readLedger({ dir }), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeLedger then readLedger round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-ledger-'))
  try {
    const ledger = {
      'a@example.com': { contacts: [{ at: daysAgo(1), play: 'declined' }], optedOut: false },
    }
    writeLedger({ dir, ledger })
    assert.deepEqual(readLedger({ dir }), ledger)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown person is contactable', () => {
  assert.equal(suppression({ record: undefined, play: 'declined', now: NOW }), null)
})

test('opting out suppresses forever, beating every other rule', () => {
  const record = { contacts: [{ at: daysAgo(5000), play: 'declined' }], optedOut: true }
  const result = suppression({ record, play: 'declined', now: NOW })
  assert.equal(result.reason, 'opted-out')
})

test('a contact inside the cooldown window suppresses', () => {
  const record = { contacts: [{ at: daysAgo(10), play: 'declined' }], optedOut: false }
  const result = suppression({ record, play: 'declined', now: NOW })
  assert.equal(result.reason, 'cooldown')
  assert.match(result.detail, /35d/)
})

test('a contact past the cooldown window is contactable again', () => {
  const record = { contacts: [{ at: daysAgo(46), play: 'declined' }], optedOut: false }
  assert.equal(suppression({ record, play: 'declined', now: NOW }), null)
})

test('cooldown is per play and lapsed is longer than declined', () => {
  assert.equal(COOLDOWN_DAYS.declined, 45)
  assert.equal(COOLDOWN_DAYS.lapsed, 60)
  const record = { contacts: [{ at: daysAgo(50), play: 'lapsed' }], optedOut: false }
  assert.equal(suppression({ record, play: 'lapsed', now: NOW }).reason, 'cooldown')
})

test('COOLDOWN_DAYS.backfill is 45 and suppression honours it', () => {
  assert.equal(COOLDOWN_DAYS.backfill, 45)
  const record = { contacts: [{ at: daysAgo(10), play: 'backfill' }], optedOut: false }
  const result = suppression({ record, play: 'backfill', now: NOW })
  assert.equal(result.reason, 'cooldown')
  assert.match(result.detail, /35d/)
})

test('cooldown counts contacts from any play, not just the current one', () => {
  const record = { contacts: [{ at: daysAgo(3), play: 'lapsed' }], optedOut: false }
  assert.equal(suppression({ record, play: 'declined', now: NOW }).reason, 'cooldown')
})

test('the lifetime cap suppresses even when every contact is ancient', () => {
  const record = {
    contacts: [
      { at: daysAgo(900), play: 'declined' },
      { at: daysAgo(600), play: 'declined' },
      { at: daysAgo(300), play: 'lapsed' },
    ],
    optedOut: false,
  }
  const result = suppression({ record, play: 'declined', now: NOW })
  assert.equal(result.reason, 'lifetime-cap')
  assert.equal(LIFETIME_CAP, 3)
})

test('recordContact appends without mutating the input ledger', () => {
  const ledger = {}
  const next = recordContact({ ledger, email: 'A@Example.com', play: 'declined', now: NOW })
  assert.deepEqual(ledger, {})
  assert.equal(next['a@example.com'].contacts.length, 1)
  assert.equal(next['a@example.com'].contacts[0].play, 'declined')
  assert.equal(next['a@example.com'].optedOut, false)
})

test('optOut sets the flag on a person with no prior contacts', () => {
  const next = optOut({ ledger: {}, email: 'New@Example.com' })
  assert.equal(next['new@example.com'].optedOut, true)
  assert.deepEqual(next['new@example.com'].contacts, [])
})

test('readLedger throws on malformed JSON, naming the path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-ledger-'))
  try {
    writeFileSync(join(dir, 'outreach.json'), 'not valid json {]')
    assert.throws(
      () => readLedger({ dir }),
      (err) => err.message.includes(join(dir, 'outreach.json')),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeLedger is atomic and round-trips correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-ledger-'))
  try {
    const ledger = {
      'alice@example.com': {
        contacts: [{ at: daysAgo(100), play: 'declined' }],
        optedOut: false,
      },
      'bob@example.com': {
        contacts: [
          { at: daysAgo(50), play: 'lapsed' },
          { at: daysAgo(20), play: 'declined' },
        ],
        optedOut: true,
      },
    }
    writeLedger({ dir, ledger })
    assert.deepEqual(readLedger({ dir }), ledger)
    assert.deepEqual(readdirSync(dir), ['outreach.json'])
    writeLedger({ dir, ledger })
    assert.deepEqual(readdirSync(dir), ['outreach.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
