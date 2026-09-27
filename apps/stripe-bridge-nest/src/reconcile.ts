import { Logger } from '@nestjs/common'
import { isoformat, parseIso } from '@wizteros/server-common'
import { eachInOrder, mapInOrder } from '@/sequence.js'
import { allCustomerRows, allMemberLinks, allMemberTags, recordEvent } from '@/store.js'
import type { Bridge, CustomerRow, WizarrUser } from '@/types.js'
import { accessDays, plusDays } from '@/webhook/handlers.js'

// The expiry sweep the reconcile loop runs after its drift alarms.

const log = new Logger('bridge')

/** Tags whose holders the sweep never time-boxes. */
const EXEMPT_TAGS: ReadonlySet<string> = new Set(['vip', 'banned'])

/** A record's email lowercased, '' when it has none: `(u.get("email") or "").lower()`. */
const emailOf = (user: WizarrUser): string => (user.email || '').toLowerCase()

/** The records one pending member holds with no expiry, found the way the docstring below says. */
const unstampedRecords = async ({
  bridge,
  users,
  links,
  email,
  row,
}: {
  bridge: Bridge
  users: readonly WizarrUser[]
  links: ReadonlyMap<string, string>
  email: string
  row: CustomerRow
}): Promise<WizarrUser[]> => {
  const byEmail = users.filter((user) => emailOf(user) === email)
  const linked = links.get(email)
  // They pay under this address and watch under another. The invite
  // fallback below cannot reach them: a member who re-subscribed
  // while already holding access never redeems the new invite.
  const matched =
    byEmail.length === 0 && linked ? users.filter((user) => emailOf(user) === linked) : byEmail
  if (matched.length > 0) {
    return matched.filter((user) => !user.expires)
  }
  const ids: ReadonlySet<number> = new Set(
    row.invite_code ? await bridge.wizarr.findUserIdsByInvite(row.invite_code) : [],
  )
  return users.filter((user) => ids.has(user.id) && !user.expires)
}

/**
 * Stamp the paid expiry on records that joined without one; returns records stamped.
 *
 * Wizarr does not translate an invite's duration into record expiry, so a
 * brand-new member redeems into records with no expiry at all — and no
 * webhook fires at redemption to correct it. Sweep every subscribed, non-VIP
 * member and stamp invited_at + ACCESS_DURATION (the signup date anchors the
 * window) on any of their records still unlimited. Records that already
 * carry an expiry are never touched. When the signup anchor is old enough
 * that the window has already closed, the expiry is re-anchored at the sweep
 * rather than stamped in the past: a background job must never revoke a
 * paying member's access, and must never leave it unbounded either.
 *
 * A member whose Plex email differs from the Stripe email (common for
 * brand-new members, who create the Plex account at redemption) matches no
 * record by email; their records are found through the invite they redeemed
 * instead. The fallback only runs when the email matches nothing at all, so
 * already-stamped members cost no extra Wizarr calls.
 */
export const reconcilePendingExpiries = async (bridge: Bridge): Promise<number> => {
  const customers = allCustomerRows({ path: bridge.dbPath })
  const tags = allMemberTags({ path: bridge.dbPath })
  const links = allMemberLinks({ path: bridge.dbPath })
  const pending = [...customers].filter(
    ([email, row]) => row.subscribed && !!row.invited_at && !EXEMPT_TAGS.has(tags.get(email) ?? ''),
  )
  if (pending.length === 0) {
    return 0
  }
  const users = await bridge.wizarr.listUsers()
  const now = new Date()
  const counts = await mapInOrder({
    items: pending,
    run: async ([email, row]): Promise<number> => {
      const records = await unstampedRecords({ bridge, users, links, email, row })
      if (records.length === 0 || !row.invited_at) {
        return 0
      }
      const days = accessDays(bridge.settings)
      const anchored = plusDays({ at: parseIso(row.invited_at), days })
      // A signup older than the access window computes a past date on every
      // sweep. Stamping it would let a background job revoke a paying
      // member's access; skipping it, which is what used to happen, left
      // them with no expiry at all and so no time-box whatsoever. Re-anchor
      // at the sweep instead: the same window any payment grants, and their
      // next renewal re-stamps it from the payment date.
      const lapsed = anchored.getTime() <= now.getTime()
      const expires = isoformat(lapsed ? plusDays({ at: now, days }) : anchored)
      await eachInOrder({
        items: records,
        run: (user) => bridge.wizarr.setExpiry({ userId: user.id, expires }),
      })
      log.log(
        `reconcile: stamped expiry ${expires} on ${records.length} record(s) for ${email}` +
          (lapsed ? ' (signup window had lapsed)' : ''),
      )
      recordEvent({
        path: bridge.dbPath,
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
