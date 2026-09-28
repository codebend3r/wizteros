import { asRow, asRows, fields, isoformat } from '@wizteros/server-common'
import type { Units } from '@/store/units.js'

// The invites the bridge minted and has to remember: which checkout session
// each member invite belongs to, and which shareable baseline invites are its
// own to reap.

/** The invite already issued for a checkout session. */
export type SessionInvite = Readonly<{ invite_code: string; emailed: boolean }>

/** One baseline invite this system minted. */
export type BaselineInvite = Readonly<{
  code: string
  tier: string
  created_at: string
  expires_at: string
}>

export const inviteStore = ({ read, write }: Units) => ({
  /**
   * The invite already issued for a checkout session, or null if there is none.
   *
   * Returns { invite_code, emailed } so a retry can tell "invite exists and
   * the member has the link" from "invite exists but the email never went out".
   */
  getSessionInvite: ({ sessionId }: { sessionId: string }): SessionInvite | null => {
    const row = read((connection) =>
      asRow(
        connection
          .prepare('SELECT invite_code, emailed FROM session_invites WHERE session_id = ?')
          .get(sessionId),
      ),
    )
    return row
      ? { invite_code: fields(row).text('invite_code'), emailed: !!fields(row).number('emailed') }
      : null
  },

  /**
   * Bind a checkout session to the invite just created for it (not yet emailed).
   *
   * Written immediately after createInvite so that a crash anywhere later in
   * the handler can never cost the member a second invite on Stripe's retry.
   */
  recordSessionInvite: ({
    sessionId,
    inviteCode,
  }: {
    sessionId: string
    inviteCode: string
  }): void => {
    write((connection) =>
      connection
        .prepare(
          `
            INSERT INTO session_invites (session_id, invite_code, emailed) VALUES (?, ?, 0)
            ON CONFLICT(session_id) DO UPDATE SET invite_code = excluded.invite_code
            `,
        )
        .run(sessionId, inviteCode),
    )
  },

  /** Record that the session's invite link actually reached the member. */
  markSessionInviteEmailed: ({ sessionId }: { sessionId: string }): void => {
    write((connection) =>
      connection
        .prepare('UPDATE session_invites SET emailed = 1 WHERE session_id = ?')
        .run(sessionId),
    )
  },

  /**
   * Remember a baseline invite this system minted, so rotation may later reap it.
   *
   * Membership in this table is the sole proof of ownership: rotation deletes
   * only codes recorded here, which is what makes it impossible for a member's
   * checkout invite to be caught by the reaper. createdAt defaults to now (an
   * empty string counts as missing) but is passed in by the rotation so it
   * shares one clock with expiresAt — the audit measures rotation liveness as
   * the gap between the two.
   */
  recordBaselineInvite: ({
    code,
    tier,
    expiresAt,
    createdAt,
  }: {
    code: string
    tier: string
    expiresAt: string
    createdAt?: string | null
  }): void => {
    const created = createdAt || isoformat(new Date())
    write((connection) =>
      connection
        .prepare(
          'INSERT OR REPLACE INTO baseline_invites (code, tier, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?)',
        )
        .run(code, tier, created, expiresAt),
    )
  },

  /** Every baseline invite this system has minted, newest first. */
  allBaselineInvites: (): BaselineInvite[] =>
    read((connection) =>
      asRows(
        connection
          .prepare(
            'SELECT code, tier, created_at, expires_at FROM baseline_invites ' +
              'ORDER BY created_at DESC',
          )
          .all(),
      ),
    ).map((row) => {
      const fieldsOf = fields(row)
      return {
        code: fieldsOf.text('code'),
        tier: fieldsOf.text('tier'),
        created_at: fieldsOf.text('created_at'),
        expires_at: fieldsOf.text('expires_at'),
      }
    }),

  /** Drop a baseline invite's record once it has been deleted upstream. */
  forgetBaselineInvite: ({ code }: { code: string }): void => {
    write((connection) =>
      connection.prepare('DELETE FROM baseline_invites WHERE code = ?').run(code),
    )
  },
})
