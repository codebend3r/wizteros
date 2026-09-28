import { Logger } from '@nestjs/common'
import { asRow, asRows, fields, isoformat, type Row } from '@wizteros/server-common'
import { stackOf } from '@/errors.js'
import type { Units } from '@/store/units.js'
import type { EventRow } from '@/types.js'

// Two logs: the Stripe events already acted on, so a redelivery is dropped,
// and each member's action history, which the member page and the income page
// read.

const log = new Logger('bridge.store')

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

export const eventStore = ({ read, write }: Units) => ({
  /** Read-only check for whether eventId has already been marked processed. */
  isEventProcessed: ({ eventId }: { eventId: string }): boolean =>
    read(
      (connection) =>
        asRow(
          connection.prepare('SELECT 1 FROM processed_events WHERE event_id = ?').get(eventId),
        ) !== null,
    ),

  /** Record eventId. Return true if newly recorded, false if already seen. */
  markEventProcessed: ({ eventId }: { eventId: string }): boolean =>
    write(
      (connection) =>
        connection
          .prepare('INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)')
          .run(eventId).changes > 0,
    ),

  /**
   * Append one action to a member's history (keyed lowercased email).
   *
   * Never throws: the history is an audit trail, and a logging failure must
   * not break or retry the action it records (e.g. a Stripe webhook).
   */
  recordEvent: ({
    email,
    action,
    detail = '',
  }: {
    email: string
    action: string
    detail?: string
  }): void => {
    try {
      write((connection) =>
        connection
          .prepare('INSERT INTO event_log (at, email, action, detail) VALUES (?, ?, ?, ?)')
          .run(isoformat(new Date()), email.toLowerCase(), action, detail),
      )
    } catch (error) {
      log.error(`event log write failed for ${email} / ${action}`, stackOf(error))
    }
  },

  /** A member's action history, newest first. */
  eventsForEmail: ({ email, limit = 100 }: { email: string; limit?: number }): EventRow[] =>
    read((connection) =>
      asRows(
        connection
          .prepare(
            'SELECT id, at, email, action, detail FROM event_log ' +
              'WHERE email = ? ORDER BY id DESC LIMIT ?',
          )
          .all(email.toLowerCase(), limit),
      ),
    ).map(eventRowOf),

  /**
   * The whole action history across every member, newest first.
   *
   * Feeds the income page, which reads signups, tier changes and
   * cancellations off it to draw the months; per-member reads stay on
   * eventsForEmail. The cap is a safety valve, not a page size: the log
   * grows by a few rows per member per month, so it is decades away, and
   * when it is reached the oldest rows (the earliest signups) go first.
   */
  allEvents: ({ limit = 50_000 }: { limit?: number } = {}): EventRow[] =>
    read((connection) =>
      asRows(
        connection
          .prepare('SELECT id, at, email, action, detail FROM event_log ORDER BY id DESC LIMIT ?')
          .all(limit),
      ),
    ).map(eventRowOf),
})
