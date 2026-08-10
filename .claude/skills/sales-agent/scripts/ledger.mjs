import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY = 86_400_000
const LEDGER_FILE = 'outreach.json'

export const COOLDOWN_DAYS = { declined: 45, lapsed: 60 }
export const LIFETIME_CAP = 3

export const stateDir = ({ env = process.env } = {}) =>
  env.WZ_SALES_STATE ?? join(env.HOME ?? '', '.local', 'state', 'wizteros', 'sales-agent')

export const readLedger = ({ dir }) => {
  try {
    return JSON.parse(readFileSync(join(dir, LEDGER_FILE), 'utf8'))
  } catch {
    return {}
  }
}

export const writeLedger = ({ dir, ledger }) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`)
}

export const suppression = ({ record, play, now }) => {
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
  const key = email.toLowerCase()
  const record = ledger[key] ?? { contacts: [], optedOut: false }
  return { ...ledger, [key]: { ...record, optedOut: true } }
}
