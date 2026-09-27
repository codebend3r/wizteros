import { Logger } from '@nestjs/common'
import type { CustomerRow, EventRow } from '@/types.js'
import {
  asRow,
  asRows,
  fields,
  flag,
  isoformat,
  type Row,
  type SqliteDatabase,
  withSqlite,
} from '@wizteros/server-common'
import { stackOf } from '@/errors.js'

const log = new Logger('bridge.store')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    tier               TEXT,
    subscribed         INTEGER NOT NULL DEFAULT 0
)
`

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY
)
`

const NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS member_notes (
    email TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT ''
)
`

const TAGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS member_tags (
    email TEXT PRIMARY KEY,
    tag   TEXT NOT NULL
)
`

const DOWNLOADS_SCHEMA = `
CREATE TABLE IF NOT EXISTS member_downloads (
    email TEXT PRIMARY KEY,
    allow INTEGER NOT NULL
)
`

const EVENT_LOG_SCHEMA = `
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
const SESSION_INVITES_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_invites (
    session_id  TEXT PRIMARY KEY,
    invite_code TEXT NOT NULL,
    emailed     INTEGER NOT NULL DEFAULT 0
)
`

const BASELINE_INVITES_SCHEMA = `
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
const MEMBER_LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS member_links (
    stripe_email TEXT PRIMARY KEY,
    plex_email   TEXT NOT NULL
)
`

const CUSTOMER_SELECT =
  'SELECT stripe_customer_id, email, invite_code, tier, invited_at, subscribed, ' +
  'payment_state FROM customer_map WHERE email IS NOT NULL'

// WHICH row answers for an email must not depend on SQLite's unordered scan. A
// member who checked out more than once has a row per attempt, all sharing an
// email. subscribed and invited_at cannot break the tie (both are written
// across every row for the email), so order by what does vary: a real cus_ row
// outranks an "admin:<email>" placeholder, and among real ones the newest
// checkout is the live one. The best row sorts last, and last is what both
// readers below keep.
const CUSTOMER_ORDER =
  " ORDER BY (CASE WHEN stripe_customer_id LIKE 'cus\\_%' ESCAPE '\\' " +
  '          THEN 1 ELSE 0 END) ASC, rowid ASC'

/** A customer's mapping as `getMapping` reads it. */
export type CustomerMapping = Readonly<{
  stripe_customer_id: string
  email: string | null
  invite_code: string | null
}>

/** The invite already issued for a checkout session. */
export type SessionInvite = Readonly<{ invite_code: string; emailed: boolean }>

/** One baseline invite this system minted. */
export type BaselineInvite = Readonly<{
  code: string
  tier: string
  created_at: string
  expires_at: string
}>

/** One customer_map row as the CustomerRow the rest of the bridge reads. */
const customerRowOf = (row: Row): CustomerRow => {
  const read = fields(row)
  const customerId = read.textOrNull('stripe_customer_id')
  return {
    customer_id: (customerId ?? '').startsWith('cus_') ? customerId : null,
    invite_code: read.textOrNull('invite_code'),
    tier: read.textOrNull('tier'),
    invited_at: read.textOrNull('invited_at'),
    subscribed: !!read.number('subscribed'),
    payment_state: read.textOrNull('payment_state'),
  }
}

/** One event_log row. */
const eventRowOf = (row: Row): EventRow => {
  const read = fields(row)
  return {
    id: read.number('id'),
    at: read.text('at'),
    email: read.text('email'),
    action: read.text('action'),
    detail: read.text('detail'),
  }
}

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
const COLUMNS: readonly (readonly [name: string, decl: string])[] = [
  ['tier', 'TEXT'],
  ['invited_at', 'TEXT'],
  ['subscribed', 'INTEGER NOT NULL DEFAULT 0'],
  ['payment_state', 'TEXT'],
]

/** Add one customer_map column to a DB that predates it; no-op once present. */
const ensureColumn = ({
  database,
  name,
  decl,
}: {
  database: SqliteDatabase
  name: string
  decl: string
}): void => {
  const cols = asRows(database.prepare('PRAGMA table_info(customer_map)').all()).map((row) =>
    fields(row).text('name'),
  )
  if (!cols.includes(name)) {
    database.prepare(`ALTER TABLE customer_map ADD COLUMN ${name} ${decl}`).run()
  }
}

const TABLES = [
  SCHEMA,
  EVENTS_SCHEMA,
  NOTES_SCHEMA,
  TAGS_SCHEMA,
  DOWNLOADS_SCHEMA,
  EVENT_LOG_SCHEMA,
  SESSION_INVITES_SCHEMA,
  BASELINE_INVITES_SCHEMA,
  MEMBER_LINKS_SCHEMA,
]

/** Create the tables if missing and backfill the added columns; safe every startup. */
export const initDb = ({ path }: { path: string }): void =>
  withSqlite({
    path,
    work: (database) => {
      TABLES.forEach((ddl) => database.prepare(ddl).run())
      COLUMNS.forEach(([name, decl]) => ensureColumn({ database, name, decl }))
    },
  })

const ADMIN_KEY_PREFIX = 'admin:'

type Column = readonly [name: string, value: string | null]

/**
 * Write the columns onto every row for the email, case-insensitively.
 *
 * When the email has no row at all, insert one keyed "admin:<email>" instead,
 * so a member an admin touched before Stripe ever heard of them still has a
 * row to be listed from. A later real checkout deletes that placeholder.
 */
const setByEmailOrPlaceholder = ({
  database,
  email,
  cols,
}: {
  database: SqliteDatabase
  email: string
  cols: readonly Column[]
}): void => {
  const names = cols.map(([name]) => name)
  const values = cols.map(([, value]) => value)
  const assignments = names.map((name) => `${name} = ?`).join(', ')
  const updated = database
    .prepare(`UPDATE customer_map SET ${assignments} WHERE lower(email) = lower(?)`)
    .run(...values, email)
  if (updated.changes === 0) {
    const marks = names.map(() => '?').join(', ')
    database
      .prepare(
        `INSERT INTO customer_map (stripe_customer_id, email, ${names.join(', ')}) ` +
          `VALUES (?, ?, ${marks})`,
      )
      .run(ADMIN_KEY_PREFIX + email.toLowerCase(), email, ...values)
  }
}

/**
 * Insert or update ("upsert") the customer -> email + invite code + tier mapping.
 *
 * Stamps invited_at with the current UTC time — every upsert corresponds to
 * a freshly issued invite, and the stamp anchors the grace-period status.
 * Marks the member subscribed: this is the confirmed-payment path (a Stripe
 * checkout completed), which is what "Subscribed Monthly" keys off.
 */
export const upsertPending = ({
  path,
  customerId,
  email,
  inviteCode,
  tier = null,
}: {
  path: string
  customerId: string
  email: string
  inviteCode: string
  tier?: string | null
}): void => {
  const invitedAt = isoformat(new Date())
  withSqlite({
    path,
    work: (database) => {
      // One row per person: a real Stripe mapping supersedes any placeholder
      // left by an admin-issued invite for the same email.
      database
        .prepare('DELETE FROM customer_map WHERE stripe_customer_id = ?')
        .run(ADMIN_KEY_PREFIX + email.toLowerCase())
      database
        .prepare(
          `
            INSERT INTO customer_map
                (stripe_customer_id, email, invite_code, tier, invited_at, subscribed)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(stripe_customer_id)
            DO UPDATE SET email = excluded.email,
                          invite_code = excluded.invite_code,
                          tier = excluded.tier,
                          invited_at = excluded.invited_at,
                          subscribed = 1
            `,
        )
        .run(customerId, email, inviteCode, tier, invitedAt)
    },
  })
}

/**
 * Record an admin-issued invite for an email with no known Stripe customer id.
 *
 * Re-points every existing row for the email (case-insensitive) at the new
 * invite code + tier and restarts the invited_at grace clock; otherwise
 * inserts a placeholder keyed "admin:<email>" so the member stays listed on
 * /manage until they redeem.
 */
export const upsertPendingByEmail = ({
  path,
  email,
  inviteCode,
  tier = null,
}: {
  path: string
  email: string
  inviteCode: string
  tier?: string | null
}): void => {
  const invitedAt = isoformat(new Date())
  withSqlite({
    path,
    work: (database) =>
      setByEmailOrPlaceholder({
        database,
        email,
        cols: [
          ['invite_code', inviteCode],
          ['tier', tier],
          ['invited_at', invitedAt],
        ],
      }),
  })
}

/**
 * Record that an invite was sent to an email: set invited_at = now only.
 *
 * Leaves tier, invite code, and the subscribed flag untouched — for members
 * invited manually outside the bridge (no bridge-issued code). Inserts an
 * admin-keyed placeholder (subscribed defaults to 0) when no row exists yet, so
 * the member reads as "Invited" on /admin/members while the grace clock runs.
 */
export const stampInvited = ({ path, email }: { path: string; email: string }): void => {
  const invitedAt = isoformat(new Date())
  withSqlite({
    path,
    work: (database) =>
      setByEmailOrPlaceholder({ database, email, cols: [['invited_at', invitedAt]] }),
  })
}

/**
 * Hard-set the recorded tier for an email, leaving its invite code alone.
 *
 * Updates every row for the email (case-insensitive); inserts an admin-keyed
 * placeholder when the bridge has no row yet so the member shows up on
 * /admin/members with the forced tier.
 */
export const setTier = ({
  path,
  email,
  tier,
}: {
  path: string
  email: string
  tier: string
}): void =>
  withSqlite({
    path,
    work: (database) => setByEmailOrPlaceholder({ database, email, cols: [['tier', tier]] }),
  })

/**
 * Set the confirmed-payment flag on every row for an email (case-insensitive).
 *
 * Driven by the Stripe webhooks — a paid invoice sets it, a deleted
 * subscription clears it. No-op when the bridge has no row for the email yet
 * (a renewal always follows the checkout that created the row).
 */
export const setSubscribed = ({
  path,
  email,
  value,
}: {
  path: string
  email: string
  value: boolean
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare('UPDATE customer_map SET subscribed = ? WHERE lower(email) = lower(?)')
        .run(flag(value), email),
  })
}

// What a Stripe subscription status means for payment_state. A status absent
// here (canceled, incomplete, paused) says nothing about the flag: the end of
// a subscription belongs to the cancel handler. A ReadonlyMap, so `has` answers
// the Python `status in PAYMENT_STATE_BY_STATUS` and `get` its lookup.
export const PAYMENT_STATE_BY_STATUS: ReadonlyMap<string, string | null> = new Map([
  ['active', null],
  ['trialing', null],
  ['past_due', 'past_due'],
  ['unpaid', 'past_due'],
])

/**
 * Record (or clear) an outstanding Stripe payment problem for an email.
 *
 * "past_due" is written by invoice.payment_failed and by a subscription that
 * Stripe moves to past_due/unpaid; null is written the moment an invoice for
 * them is paid. Deliberately separate from `subscribed`: a member in dunning
 * has still paid for the period they are in, so their access is untouched.
 * What changes is that the admin UI stops calling them healthy.
 */
export const setPaymentState = ({
  path,
  email,
  state,
}: {
  path: string
  email: string
  state: string | null
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare('UPDATE customer_map SET payment_state = ? WHERE lower(email) = lower(?)')
        .run(state, email),
  })
}

/** Read-only check for whether eventId has already been marked processed. */
export const isEventProcessed = ({ path, eventId }: { path: string; eventId: string }): boolean =>
  withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(database.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(eventId)) !==
      null,
  })

/** Record eventId. Return true if newly recorded, false if already seen. */
export const markEventProcessed = ({ path, eventId }: { path: string; eventId: string }): boolean =>
  withSqlite({
    path,
    work: (database) =>
      database.prepare('INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)').run(eventId)
        .changes > 0,
  })

/**
 * The invite already issued for a checkout session, or null if there is none.
 *
 * Returns { invite_code, emailed } so a retry can tell "invite exists and
 * the member has the link" from "invite exists but the email never went out".
 */
export const getSessionInvite = ({
  path,
  sessionId,
}: {
  path: string
  sessionId: string
}): SessionInvite | null => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database
          .prepare('SELECT invite_code, emailed FROM session_invites WHERE session_id = ?')
          .get(sessionId),
      ),
  })
  return row
    ? { invite_code: fields(row).text('invite_code'), emailed: !!fields(row).number('emailed') }
    : null
}

/**
 * Bind a checkout session to the invite just created for it (not yet emailed).
 *
 * Written immediately after createInvite so that a crash anywhere later in
 * the handler can never cost the member a second invite on Stripe's retry.
 */
export const recordSessionInvite = ({
  path,
  sessionId,
  inviteCode,
}: {
  path: string
  sessionId: string
  inviteCode: string
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare(
          `
            INSERT INTO session_invites (session_id, invite_code, emailed) VALUES (?, ?, 0)
            ON CONFLICT(session_id) DO UPDATE SET invite_code = excluded.invite_code
            `,
        )
        .run(sessionId, inviteCode),
  })
}

/** Record that the session's invite link actually reached the member. */
export const markSessionInviteEmailed = ({
  path,
  sessionId,
}: {
  path: string
  sessionId: string
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare('UPDATE session_invites SET emailed = 1 WHERE session_id = ?')
        .run(sessionId),
  })
}

/**
 * Real Stripe customer ids recorded for an email, case-insensitive.
 *
 * Admin-issued placeholder rows (keyed "admin:<email>") are excluded — they
 * have no Stripe side to act on.
 */
export const customerIdsForEmail = ({ path, email }: { path: string; email: string }): string[] =>
  withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRows(
        database
          .prepare('SELECT stripe_customer_id FROM customer_map WHERE lower(email) = lower(?)')
          .all(email),
      ),
  })
    .map((row) => fields(row).text('stripe_customer_id'))
    .filter((customerId) => !customerId.startsWith(ADMIN_KEY_PREFIX))

/** Fetch a customer's mapping as a plain object, or null if unknown. */
export const getMapping = ({
  path,
  customerId,
}: {
  path: string
  customerId: string
}): CustomerMapping | null => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database
          .prepare(
            'SELECT stripe_customer_id, email, invite_code ' +
              'FROM customer_map WHERE stripe_customer_id = ?',
          )
          .get(customerId),
      ),
  })
  if (!row) {
    return null
  }
  const read = fields(row)
  return {
    stripe_customer_id: read.text('stripe_customer_id'),
    email: read.textOrNull('email'),
    invite_code: read.textOrNull('invite_code'),
  }
}

/** Map lowercased email -> tier for every mapping that has a tier recorded. */
export const tiersByEmail = ({ path }: { path: string }): ReadonlyMap<string, string> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) =>
        asRows(
          database
            .prepare(
              'SELECT email, tier FROM customer_map WHERE tier IS NOT NULL AND email IS NOT NULL',
            )
            .all(),
        ),
    }).map((row) => [fields(row).text('email').toLowerCase(), fields(row).text('tier')] as const),
  )

/** The admin's free-form notes for an email; empty string when none saved. */
export const getMemberNotes = ({ path, email }: { path: string; email: string }): string => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database.prepare('SELECT notes FROM member_notes WHERE email = ?').get(email.toLowerCase()),
      ),
  })
  return row ? fields(row).text('notes') : ''
}

/** Save (overwrite) the admin's notes for an email; keyed lowercased. */
export const setMemberNotes = ({
  path,
  email,
  notes,
}: {
  path: string
  email: string
  notes: string
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare(
          `
            INSERT INTO member_notes (email, notes) VALUES (?, ?)
            ON CONFLICT(email) DO UPDATE SET notes = excluded.notes
            `,
        )
        .run(email.toLowerCase(), notes),
  })
}

/** Save the manual designation for an email (keyed lowercased); null clears it. */
export const setMemberTag = ({
  path,
  email,
  tag,
}: {
  path: string
  email: string
  tag: string | null
}): void => {
  withSqlite({
    path,
    work: (database) =>
      tag === null
        ? database.prepare('DELETE FROM member_tags WHERE email = ?').run(email.toLowerCase())
        : database
            .prepare(
              `
                INSERT INTO member_tags (email, tag) VALUES (?, ?)
                ON CONFLICT(email) DO UPDATE SET tag = excluded.tag
                `,
            )
            .run(email.toLowerCase(), tag),
  })
}

/** The member's manual designation ("vip"/"hvu"), or null when untagged. */
export const getMemberTag = ({ path, email }: { path: string; email: string }): string | null => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database.prepare('SELECT tag FROM member_tags WHERE email = ?').get(email.toLowerCase()),
      ),
  })
  return row ? fields(row).text('tag') : null
}

/**
 * Record that `stripeEmail` bills for the person watching as `plexEmail`.
 *
 * A null `plexEmail` clears the link, which puts the Stripe address back on
 * the members list as its own row. Both are stored lowercased, the same key
 * the customer map and the Wizarr user join use.
 */
export const setMemberLink = ({
  path,
  stripeEmail,
  plexEmail,
}: {
  path: string
  stripeEmail: string
  plexEmail: string | null
}): void => {
  withSqlite({
    path,
    work: (database) =>
      plexEmail === null
        ? database
            .prepare('DELETE FROM member_links WHERE stripe_email = ?')
            .run(stripeEmail.toLowerCase())
        : database
            .prepare(
              `
                INSERT INTO member_links (stripe_email, plex_email) VALUES (?, ?)
                ON CONFLICT(stripe_email) DO UPDATE SET plex_email = excluded.plex_email
                `,
            )
            .run(stripeEmail.toLowerCase(), plexEmail.toLowerCase()),
  })
}

/** The Plex address this Stripe address pays for, or null when unlinked. */
export const getMemberLink = ({
  path,
  stripeEmail,
}: {
  path: string
  stripeEmail: string
}): string | null => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database
          .prepare('SELECT plex_email FROM member_links WHERE stripe_email = ?')
          .get(stripeEmail.toLowerCase()),
      ),
  })
  return row ? fields(row).text('plex_email') : null
}

/** Map lowercased Stripe address -> the Plex address it pays for. */
export const allMemberLinks = ({ path }: { path: string }): ReadonlyMap<string, string> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) =>
        asRows(database.prepare('SELECT stripe_email, plex_email FROM member_links').all()),
    }).map((row) => [fields(row).text('stripe_email'), fields(row).text('plex_email')] as const),
  )

/** Map lowercased email -> manual tag for every tagged member. */
export const allMemberTags = ({ path }: { path: string }): ReadonlyMap<string, string> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) => asRows(database.prepare('SELECT email, tag FROM member_tags').all()),
    }).map((row) => [fields(row).text('email'), fields(row).text('tag')] as const),
  )

/** Save the admin's downloads override for an email (keyed lowercased). */
export const setMemberDownloads = ({
  path,
  email,
  allow,
}: {
  path: string
  email: string
  allow: boolean
}): void => {
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare(
          `
            INSERT INTO member_downloads (email, allow) VALUES (?, ?)
            ON CONFLICT(email) DO UPDATE SET allow = excluded.allow
            `,
        )
        .run(email.toLowerCase(), flag(allow)),
  })
}

/** The downloads override for an email; null when the tier default applies. */
export const getMemberDownloads = ({
  path,
  email,
}: {
  path: string
  email: string
}): boolean | null => {
  const row = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRow(
        database
          .prepare('SELECT allow FROM member_downloads WHERE email = ?')
          .get(email.toLowerCase()),
      ),
  })
  return row ? !!fields(row).number('allow') : null
}

/** Map lowercased email -> downloads override for every overridden member. */
export const allMemberDownloads = ({ path }: { path: string }): ReadonlyMap<string, boolean> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) =>
        asRows(database.prepare('SELECT email, allow FROM member_downloads').all()),
    }).map((row) => [fields(row).text('email'), !!fields(row).number('allow')] as const),
  )

/**
 * Append one action to a member's history (keyed lowercased email).
 *
 * Never throws: the history is an audit trail, and a logging failure must
 * not break or retry the action it records (e.g. a Stripe webhook).
 */
export const recordEvent = ({
  path,
  email,
  action,
  detail = '',
}: {
  path: string
  email: string
  action: string
  detail?: string
}): void => {
  try {
    withSqlite({
      path,
      work: (database) =>
        database
          .prepare('INSERT INTO event_log (at, email, action, detail) VALUES (?, ?, ?, ?)')
          .run(isoformat(new Date()), email.toLowerCase(), action, detail),
    })
  } catch (error) {
    log.error(`event log write failed for ${email} / ${action}`, stackOf(error))
  }
}

/** A member's action history, newest first. */
export const eventsForEmail = ({
  path,
  email,
  limit = 100,
}: {
  path: string
  email: string
  limit?: number
}): EventRow[] =>
  withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRows(
        database
          .prepare(
            'SELECT id, at, email, action, detail FROM event_log ' +
              'WHERE email = ? ORDER BY id DESC LIMIT ?',
          )
          .all(email.toLowerCase(), limit),
      ),
  }).map(eventRowOf)

/**
 * The whole action history across every member, newest first.
 *
 * Feeds the income page, which reads signups, tier changes and
 * cancellations off it to draw the months; per-member reads stay on
 * eventsForEmail. The cap is a safety valve, not a page size: the log
 * grows by a few rows per member per month, so it is decades away, and
 * when it is reached the oldest rows (the earliest signups) go first.
 */
export const allEvents = ({ path, limit = 50_000 }: { path: string; limit?: number }): EventRow[] =>
  withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRows(
        database
          .prepare('SELECT id, at, email, action, detail FROM event_log ORDER BY id DESC LIMIT ?')
          .all(limit),
      ),
  }).map(eventRowOf)

/**
 * Every customer's lowercased email -> tier (tier may be null).
 *
 * Unlike tiersByEmail, this keeps rows with no tier yet, so the admin table
 * can list every subscriber the bridge knows about — including people who paid
 * but have not redeemed their Wizarr invite — not just those with Plex records.
 */
export const allCustomerTiers = ({ path }: { path: string }): ReadonlyMap<string, string | null> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) =>
        asRows(
          database.prepare('SELECT email, tier FROM customer_map WHERE email IS NOT NULL').all(),
        ),
    }).map(
      (row) => [fields(row).text('email').toLowerCase(), fields(row).textOrNull('tier')] as const,
    ),
  )

/**
 * Every customer's lowercased email -> their CustomerRow.
 *
 * Exactly one entry per email: when several customer rows share one, the
 * newest real Stripe customer wins (see the ordering above). A Map keeps the
 * last value written for a key, as the Python dict comprehension did.
 */
export const allCustomerRows = ({ path }: { path: string }): ReadonlyMap<string, CustomerRow> =>
  new Map(
    withSqlite({
      path,
      mode: 'read',
      work: (database) => asRows(database.prepare(`${CUSTOMER_SELECT}${CUSTOMER_ORDER}`).all()),
    }).map((row) => [fields(row).text('email').toLowerCase(), customerRowOf(row)] as const),
  )

/**
 * The one customer row for an email, or null when the bridge has none.
 *
 * The same row allCustomerRows would answer with, without reading every
 * customer to find out one member's tier.
 */
export const customerRow = ({
  path,
  email,
}: {
  path: string
  email: string
}): CustomerRow | null => {
  const last = withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRows(
        database
          .prepare(`${CUSTOMER_SELECT} AND lower(email) = lower(?)${CUSTOMER_ORDER}`)
          .all(email),
      ),
  }).at(-1)
  return last ? customerRowOf(last) : null
}

/**
 * Remember a baseline invite this system minted, so rotation may later reap it.
 *
 * Membership in this table is the sole proof of ownership: rotation deletes
 * only codes recorded here, which is what makes it impossible for a member's
 * checkout invite to be caught by the reaper. createdAt defaults to now (an
 * empty string counts as missing, as Python's `or` did) but is passed in by
 * the rotation so it shares one clock with expiresAt — the audit measures
 * rotation liveness as the gap between the two.
 */
export const recordBaselineInvite = ({
  path,
  code,
  tier,
  expiresAt,
  createdAt,
}: {
  path: string
  code: string
  tier: string
  expiresAt: string
  createdAt?: string | null
}): void => {
  const created = createdAt || isoformat(new Date())
  withSqlite({
    path,
    work: (database) =>
      database
        .prepare(
          'INSERT OR REPLACE INTO baseline_invites (code, tier, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?)',
        )
        .run(code, tier, created, expiresAt),
  })
}

/** Every baseline invite this system has minted, newest first. */
export const allBaselineInvites = ({ path }: { path: string }): BaselineInvite[] =>
  withSqlite({
    path,
    mode: 'read',
    work: (database) =>
      asRows(
        database
          .prepare(
            'SELECT code, tier, created_at, expires_at FROM baseline_invites ' +
              'ORDER BY created_at DESC',
          )
          .all(),
      ),
  }).map((row) => {
    const read = fields(row)
    return {
      code: read.text('code'),
      tier: read.text('tier'),
      created_at: read.text('created_at'),
      expires_at: read.text('expires_at'),
    }
  })

/** Drop a baseline invite's record once it has been deleted upstream. */
export const forgetBaselineInvite = ({ path, code }: { path: string; code: string }): void => {
  withSqlite({
    path,
    work: (database) => database.prepare('DELETE FROM baseline_invites WHERE code = ?').run(code),
  })
}
