import {
  asRow,
  asRows,
  fields,
  flag,
  isoformat,
  type Row,
  type SqliteDatabase,
} from '@wizteros/server-common'
import type { Units } from '@/store/units.js'
import type { CustomerRow } from '@/types.js'

// customer_map: what the bridge knows about each paying address. A row is keyed
// by its Stripe customer id, or by "admin:<email>" for a member an admin
// invited before Stripe ever heard of them.

const ADMIN_KEY_PREFIX = 'admin:'

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

type Column = readonly [name: string, value: string | null]

/**
 * Write the columns onto every row for the email, case-insensitively.
 *
 * When the email has no row at all, insert one keyed "admin:<email>" instead,
 * so a member an admin touched before Stripe ever heard of them still has a
 * row to be listed from. A later real checkout deletes that placeholder.
 */
const setByEmailOrPlaceholder = ({
  connection,
  email,
  cols,
}: {
  connection: SqliteDatabase
  email: string
  cols: readonly Column[]
}): void => {
  const names = cols.map(([name]) => name)
  const values = cols.map(([, value]) => value)
  const assignments = names.map((name) => `${name} = ?`).join(', ')
  const updated = connection
    .prepare(`UPDATE customer_map SET ${assignments} WHERE lower(email) = lower(?)`)
    .run(...values, email)
  if (updated.changes === 0) {
    const marks = names.map(() => '?').join(', ')
    connection
      .prepare(
        `INSERT INTO customer_map (stripe_customer_id, email, ${names.join(', ')}) ` +
          `VALUES (?, ?, ${marks})`,
      )
      .run(ADMIN_KEY_PREFIX + email.toLowerCase(), email, ...values)
  }
}

export const customerStore = ({ read, write }: Units) => ({
  /**
   * Insert or update ("upsert") the customer -> email + invite code + tier mapping.
   *
   * Stamps invited_at with the current UTC time — every upsert corresponds to
   * a freshly issued invite, and the stamp anchors the grace-period status.
   * Marks the member subscribed: this is the confirmed-payment path (a Stripe
   * checkout completed), which is what "Subscribed Monthly" keys off.
   */
  upsertPending: ({
    customerId,
    email,
    inviteCode,
    tier = null,
  }: {
    customerId: string
    email: string
    inviteCode: string
    tier?: string | null
  }): void => {
    const invitedAt = isoformat(new Date())
    write((connection) => {
      // One row per person: a real Stripe mapping supersedes any placeholder
      // left by an admin-issued invite for the same email.
      connection
        .prepare('DELETE FROM customer_map WHERE stripe_customer_id = ?')
        .run(ADMIN_KEY_PREFIX + email.toLowerCase())
      connection
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
    })
  },

  /**
   * Record an admin-issued invite for an email with no known Stripe customer id.
   *
   * Re-points every existing row for the email (case-insensitive) at the new
   * invite code + tier and restarts the invited_at grace clock; otherwise
   * inserts a placeholder keyed "admin:<email>" so the member stays listed on
   * /manage until they redeem.
   */
  upsertPendingByEmail: ({
    email,
    inviteCode,
    tier = null,
  }: {
    email: string
    inviteCode: string
    tier?: string | null
  }): void => {
    const invitedAt = isoformat(new Date())
    write((connection) =>
      setByEmailOrPlaceholder({
        connection,
        email,
        cols: [
          ['invite_code', inviteCode],
          ['tier', tier],
          ['invited_at', invitedAt],
        ],
      }),
    )
  },

  /**
   * Record that an invite was sent to an email: set invited_at = now only.
   *
   * Leaves tier, invite code, and the subscribed flag untouched — for members
   * invited manually outside the bridge (no bridge-issued code). Inserts an
   * admin-keyed placeholder (subscribed defaults to 0) when no row exists yet, so
   * the member reads as "Invited" on /admin/members while the grace clock runs.
   */
  stampInvited: ({ email }: { email: string }): void => {
    const invitedAt = isoformat(new Date())
    write((connection) =>
      setByEmailOrPlaceholder({ connection, email, cols: [['invited_at', invitedAt]] }),
    )
  },

  /**
   * Hard-set the recorded tier for an email, leaving its invite code alone.
   *
   * Updates every row for the email (case-insensitive); inserts an admin-keyed
   * placeholder when the bridge has no row yet so the member shows up on
   * /admin/members with the forced tier.
   */
  setTier: ({ email, tier }: { email: string; tier: string }): void =>
    write((connection) => setByEmailOrPlaceholder({ connection, email, cols: [['tier', tier]] })),

  /**
   * Set the confirmed-payment flag on every row for an email (case-insensitive).
   *
   * Driven by the Stripe webhooks — a paid invoice sets it, a deleted
   * subscription clears it. No-op when the bridge has no row for the email yet
   * (a renewal always follows the checkout that created the row).
   */
  setSubscribed: ({ email, value }: { email: string; value: boolean }): void => {
    write((connection) =>
      connection
        .prepare('UPDATE customer_map SET subscribed = ? WHERE lower(email) = lower(?)')
        .run(flag(value), email),
    )
  },

  /**
   * Record (or clear) an outstanding Stripe payment problem for an email.
   *
   * "past_due" is written by invoice.payment_failed and by a subscription that
   * Stripe moves to past_due/unpaid; null is written the moment an invoice for
   * them is paid. Deliberately separate from `subscribed`: a member in dunning
   * has still paid for the period they are in, so their access is untouched.
   * What changes is that the admin UI stops calling them healthy.
   */
  setPaymentState: ({ email, state }: { email: string; state: string | null }): void => {
    write((connection) =>
      connection
        .prepare('UPDATE customer_map SET payment_state = ? WHERE lower(email) = lower(?)')
        .run(state, email),
    )
  },

  /**
   * Real Stripe customer ids recorded for an email, case-insensitive.
   *
   * Admin-issued placeholder rows (keyed "admin:<email>") are excluded — they
   * have no Stripe side to act on.
   */
  customerIdsForEmail: ({ email }: { email: string }): string[] =>
    read((connection) =>
      asRows(
        connection
          .prepare('SELECT stripe_customer_id FROM customer_map WHERE lower(email) = lower(?)')
          .all(email),
      ),
    )
      .map((row) => fields(row).text('stripe_customer_id'))
      .filter((customerId) => !customerId.startsWith(ADMIN_KEY_PREFIX)),

  /** Fetch a customer's mapping, or null if unknown. */
  getMapping: ({ customerId }: { customerId: string }): CustomerMapping | null => {
    const row = read((connection) =>
      asRow(
        connection
          .prepare(
            'SELECT stripe_customer_id, email, invite_code ' +
              'FROM customer_map WHERE stripe_customer_id = ?',
          )
          .get(customerId),
      ),
    )
    if (!row) {
      return null
    }
    const fieldsOf = fields(row)
    return {
      stripe_customer_id: fieldsOf.text('stripe_customer_id'),
      email: fieldsOf.textOrNull('email'),
      invite_code: fieldsOf.textOrNull('invite_code'),
    }
  },

  /**
   * Every customer's lowercased email -> their CustomerRow.
   *
   * Exactly one entry per email: when several customer rows share one, the
   * newest real Stripe customer wins (see CUSTOMER_ORDER). A Map keeps the
   * last value written for a key.
   */
  allCustomerRows: (): ReadonlyMap<string, CustomerRow> =>
    new Map(
      read((connection) =>
        asRows(connection.prepare(`${CUSTOMER_SELECT}${CUSTOMER_ORDER}`).all()),
      ).map((row) => [fields(row).text('email').toLowerCase(), customerRowOf(row)] as const),
    ),

  /**
   * The one customer row for an email, or null when the bridge has none.
   *
   * The same row allCustomerRows would answer with, without reading every
   * customer to find out one member's tier.
   */
  customerRow: ({ email }: { email: string }): CustomerRow | null => {
    const last = read((connection) =>
      asRows(
        connection
          .prepare(`${CUSTOMER_SELECT} AND lower(email) = lower(?)${CUSTOMER_ORDER}`)
          .all(email),
      ),
    ).at(-1)
    return last ? customerRowOf(last) : null
  },
})
