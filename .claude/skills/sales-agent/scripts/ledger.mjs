import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const DAY = 86_400_000
const LEDGER_FILE = 'outreach.json'

export const COOLDOWN_DAYS = { declined: 45, lapsed: 60, backfill: 45 }
export const LIFETIME_CAP = 3

export const stateDir = ({ env = process.env } = {}) =>
  env.WZ_SALES_STATE ?? join(env.HOME ?? '', '.local', 'state', 'wizteros', 'sales-agent')

export const readLedger = ({ dir }) => {
  /**
   * Read the ledger from disk. Returns an empty object if the file is missing
   * (first-run case). Throws an Error if the file exists but is corrupted or
   * unreadable, naming the path and underlying reason, so the run stops instead
   * of silently discarding opt-outs and cooldowns.
   */
  const path = join(dir, LEDGER_FILE)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {}
    }
    throw new Error(`Failed to read ledger at ${path}: ${err.message}`)
  }
}

export const writeLedger = ({ dir, ledger }) => {
  /**
   * Persist the ledger to disk atomically. Creates the state directory on first
   * write. Writes to a temporary file in the same directory, then renames it into
   * place, so a crash mid-write can never leave a half-written or truncated ledger.
   */
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LEDGER_FILE)
  const tmpPath = join(dir, `${LEDGER_FILE}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`)
  renameSync(tmpPath, path)
}

export const suppression = ({ record, play, now }) => {
  /**
   * Why this person must not be contacted for this play, or null if they may be.
   *
   * Check order is deliberate: an opt-out beats everything and never expires.
   * The lifetime cap beats the cooldown because an expired cooldown must not
   * revive someone who has already ignored three emails. The cooldown counts
   * contacts from any play (not per-play), so two plays cannot double up on
   * one person.
   */
  if (!record) {
    return null
  }
  if (record.optedOut) {
    return { reason: 'opted-out', detail: 'opted out, permanent' }
  }
  const contacts = record.contacts ?? []
  if (contacts.length >= LIFETIME_CAP) {
    return { reason: 'lifetime-cap', detail: `${contacts.length} lifetime contacts` }
  }
  const latest = contacts.reduce(
    (acc, contact) => Math.max(acc, Date.parse(contact.at) || 0),
    0,
  )
  if (!latest) {
    return null
  }
  const waitDays = COOLDOWN_DAYS[play] ?? COOLDOWN_DAYS.declined
  const elapsedDays = Math.floor((now - latest) / DAY)
  return elapsedDays >= waitDays
    ? null
    : { reason: 'cooldown', detail: `${waitDays - elapsedDays}d left of ${waitDays}d` }
}

export const recordContact = ({ ledger, email, play, now }) => {
  /**
   * Append one contact for an email, returning a new ledger without mutating
   * the input. Email is normalized to lowercase for consistent key storage.
   */
  const key = email.toLowerCase()
  const record = ledger[key] ?? { contacts: [], optedOut: false }
  return {
    ...ledger,
    [key]: {
      ...record,
      contacts: [...record.contacts, { at: new Date(now).toISOString(), play }],
    },
  }
}

export const optOut = ({ ledger, email }) => {
  /**
   * Set the permanent exclusion flag for an email, returning a new ledger
   * without mutating the input. Email is normalized to lowercase.
   */
  const key = email.toLowerCase()
  const record = ledger[key] ?? { contacts: [], optedOut: false }
  return { ...ledger, [key]: { ...record, optedOut: true } }
}
