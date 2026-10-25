import { asRow, asRows, fields, isoformat } from '@wizteros/server-common'
import type { Units } from '@/store/units.js'

// Durable bindings for invite issuance and ownership of baseline invites.
// The legacy session_invites table is kept so existing checkout bindings
// survive upgrades unchanged; recovery keys use a separate namespace.

export type InviteOperation = Readonly<{ kind: 'checkout' | 'recovery'; id: string }>
export type InviteIssuance = Readonly<{ invite_code: string; emailed: boolean }>
const operationKey = ({ kind, id }: InviteOperation): string =>
  kind === 'checkout' ? id : `invoice:${id}`

/** One baseline invite this system minted. */
export type BaselineInvite = Readonly<{
  code: string
  tier: string
  created_at: string
  expires_at: string
}>

export const inviteStore = ({ read, write }: Units) => ({
  /**
   * The invite already issued for an operation, or null if there is none.
   *
   * Returns { invite_code, emailed } so a retry can tell "invite exists and
   * the member has the link" from "invite exists but the email never went out".
   */
  getInviteIssuance: ({ operation }: { operation: InviteOperation }): InviteIssuance | null => {
    const row = read((connection) =>
      asRow(
        connection
          .prepare('SELECT invite_code, emailed FROM session_invites WHERE session_id = ?')
          .get(operationKey(operation)),
      ),
    )
    return row
      ? { invite_code: fields(row).text('invite_code'), emailed: !!fields(row).number('emailed') }
      : null
  },

  /**
   * Bind an operation to the invite just created for it (not yet emailed).
   * Once recorded, a binding cannot be overwritten on a later retry.
   * A crash between remote creation and this write is still not atomic.
   */
  recordInviteIssuance: ({
    operation,
    inviteCode,
  }: {
    operation: InviteOperation
    inviteCode: string
  }): void => {
    write((connection) =>
      connection
        .prepare(
          `
            INSERT INTO session_invites (session_id, invite_code, emailed) VALUES (?, ?, 0)
            ON CONFLICT(session_id) DO NOTHING
            `,
        )
        .run(operationKey(operation), inviteCode),
    )
  },

  /** Record successful delivery of the operation's invite link. */
  markInviteEmailed: ({ operation }: { operation: InviteOperation }): void => {
    write((connection) =>
      connection
        .prepare('UPDATE session_invites SET emailed = 1 WHERE session_id = ?')
        .run(operationKey(operation)),
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
