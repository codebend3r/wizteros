import { asRows, fields, type SqliteDatabase } from '@wizteros/server-common'

const CUSTOMER_MAP = `
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    tier               TEXT,
    subscribed         INTEGER NOT NULL DEFAULT 0
)
`

const PROCESSED_EVENTS = `
CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY
)
`

const MEMBER_NOTES = `
CREATE TABLE IF NOT EXISTS member_notes (
    email TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT ''
)
`

const MEMBER_TAGS = `
CREATE TABLE IF NOT EXISTS member_tags (
    email TEXT PRIMARY KEY,
    tag   TEXT NOT NULL
)
`

const MEMBER_DOWNLOADS = `
CREATE TABLE IF NOT EXISTS member_downloads (
    email TEXT PRIMARY KEY,
    allow INTEGER NOT NULL
)
`

const EVENT_LOG = `
CREATE TABLE IF NOT EXISTS event_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    email  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
)
`

// One row per checkout session, written the moment its invite exists. A Stripe
// retry of the same session reads this instead of minting a second invite.
const SESSION_INVITES = `
CREATE TABLE IF NOT EXISTS session_invites (
    session_id  TEXT PRIMARY KEY,
    invite_code TEXT NOT NULL,
    emailed     INTEGER NOT NULL DEFAULT 0
)
`

const BASELINE_INVITES = `
CREATE TABLE IF NOT EXISTS baseline_invites (
    code       TEXT PRIMARY KEY,
    tier       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
)
`

// An admin's statement that two addresses are one person. The automatic join
// (a redeemed invite's used_by) answers only for members who actually redeemed
// the invite their checkout issued; someone who re-subscribes under a re-typed
// address while already holding access never redeems the new one, so nothing
// ties the paying customer to the Plex account they watch with. Keyed on the
// Stripe address because that is the row that must stop standing on its own;
// one person can pay under several addresses, so plex_email is not unique.
const MEMBER_LINKS = `
CREATE TABLE IF NOT EXISTS member_links (
    stripe_email TEXT PRIMARY KEY,
    plex_email   TEXT NOT NULL
)
`

const TABLES = [
  CUSTOMER_MAP,
  PROCESSED_EVENTS,
  MEMBER_NOTES,
  MEMBER_TAGS,
  MEMBER_DOWNLOADS,
  EVENT_LOG,
  SESSION_INVITES,
  BASELINE_INVITES,
  MEMBER_LINKS,
]

// Columns added to customer_map after the table first shipped, each ALTERed
// onto a prod DB that predates it and skipped once present. This list is the
// schema history:
//
//   tier           the plan a pre-tier prod DB has no column for.
//   invited_at     when the current invite went out; a pre-grace-period prod DB
//                  has no column for it.
//   subscribed     the durable record of a confirmed Stripe payment - set by
//                  the webhooks, not inferred from a Wizarr expiry - so a
//                  member can carry an expiry (a manual access deadline)
//                  without reading as a paying subscriber.
//   payment_state  Stripe keeps charging a failed subscription for weeks before
//                  it gives up and deletes it. Until this column existed the
//                  bridge heard nothing in between: `subscribed` stayed 1 from
//                  the last good payment, the member read "Subscribed Monthly"
//                  in the admin UI, and the first visible sign of trouble was
//                  their access expiring out from under them. NULL means "no
//                  problem known"; "past_due" means Stripe has a failed charge
//                  outstanding.
const ADDED_COLUMNS: readonly (readonly [name: string, decl: string])[] = [
  ['tier', 'TEXT'],
  ['invited_at', 'TEXT'],
  ['subscribed', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_state', 'TEXT'],
]

/** Create the tables if missing and backfill the added columns; safe every startup. */
export const initSchema = ({ connection }: { connection: SqliteDatabase }): void => {
  TABLES.forEach((ddl) => connection.prepare(ddl).run())
  const present = new Set(
    asRows(connection.prepare('PRAGMA table_info(customer_map)').all()).map((row) =>
      fields(row).text('name'),
    ),
  )
  ADDED_COLUMNS.filter(([name]) => !present.has(name)).forEach(([name, decl]) =>
    connection.prepare(`ALTER TABLE customer_map ADD COLUMN ${name} ${decl}`).run(),
  )
}
