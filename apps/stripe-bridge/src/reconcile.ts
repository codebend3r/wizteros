import { Logger } from '@nestjs/common'
import { addDays, isoformat, parseIso } from '@wizteros/server-common'
import { type Identity, identityFor } from '@/identity.js'
import { identitySnapshot, standingOf } from '@/members.js'
import { eachInOrder, mapInOrder } from '@/sequence.js'
import { isTimeBoxed } from '@/standing.js'
import type { Bridge, WizarrUser } from '@/types.js'

// The expiry sweep the reconcile loop runs after its drift alarms.

const log = new Logger('bridge')

/**
 * The records one pending member holds with no expiry, found the way the docstring below says.
 *
 * A member who pays under this address and watches under a linked one is
 * found through the link: the invite fallback cannot reach them, since a
 * member who re-subscribed while already holding access never redeems the
 * new invite.
 */
const unstampedRecords = (identity: Identity): WizarrUser[] =>
  identity.records.filter((user) => !user.expires)

/**
 * Stamp the paid expiry on records that joined without one; returns records stamped.
 *
 * Wizarr does not translate an invite's duration into record expiry, so a
 * brand-new member redeems into records with no expiry at all — and no
 * webhook fires at redemption to correct it. Sweep every subscribed member
 * who is neither VIP nor banned under any of their addresses, and stamp
 * invited_at + ACCESS_DURATION (the signup date anchors the window) on any
 * of their records still unlimited. Records that already
 * carry an expiry are never touched. When the signup anchor is old enough
 * that the window has already closed, the expiry is re-anchored at the sweep
 * rather than stamped in the past: a background job must never revoke a
 * paying member's access, and must never leave it unbounded either.
 *
 * A member whose Plex email differs from the Stripe email (common for
 * brand-new members, who create the Plex account at redemption) matches no
 * record by email; their records are found through the invite they redeemed
 * instead. Every member is resolved from one snapshot, so the sweep reads
 * Wizarr's users and invitations once however many members are pending.
 */
export const reconcilePendingExpiries = async (bridge: Bridge): Promise<number> => {
  const customers = bridge.store.allCustomerRows()
  const tags = bridge.store.allMemberTags()
  const paying = [...customers].filter(([, row]) => row.subscribed && !!row.invited_at)
  if (paying.length === 0) {
    return 0
  }
  const snapshot = await identitySnapshot(bridge)
  // A VIP or ban tagged under the member's Plex address governs the payer too.
  const pending = paying.flatMap(([email, row]) => {
    const identity = identityFor({ snapshot, email, inviteCode: row.invite_code })
    return isTimeBoxed(standingOf({ bridge, identity, tags })) ? [{ email, row, identity }] : []
  })
  const now = new Date()
  const counts = await mapInOrder({
    items: pending,
    run: async ({ email, row, identity }): Promise<number> => {
      const records = unstampedRecords(identity)
      if (records.length === 0 || !row.invited_at) {
        return 0
      }
      const days = bridge.settings.accessDays
      const anchored = addDays({ at: parseIso(row.invited_at), days })
      // A signup older than the access window computes a past date on every
      // sweep. Stamping it would let a background job revoke a paying
      // member's access; skipping it, which is what used to happen, left
      // them with no expiry at all and so no time-box whatsoever. Re-anchor
      // at the sweep instead: the same window any payment grants, and their
      // next renewal re-stamps it from the payment date.
      const lapsed = anchored.getTime() <= now.getTime()
      const expires = isoformat(lapsed ? addDays({ at: now, days }) : anchored)
      await eachInOrder({
        items: records,
        run: (user) => bridge.wizarr.setExpiry({ userId: user.id, expires }),
      })
      log.log(
        `reconcile: stamped expiry ${expires} on ${records.length} record(s) for ${email}` +
          (lapsed ? ' (signup window had lapsed)' : ''),
      )
      bridge.store.recordEvent({
        email,
        action: 'Expiry stamped',
        detail: lapsed
          ? `signup window had already lapsed; re-anchored to ${expires.slice(0, 10)}`
          : `joined with no expiry, set to ${expires.slice(0, 10)}`,
      })
      return records.length
    },
  })
  return counts.reduce((total, count) => total + count, 0)
}
