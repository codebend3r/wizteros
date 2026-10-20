import { Logger } from '@nestjs/common'
import { type Identity, type IdentitySnapshot, identityFor } from '@/identity.js'
import { type MemberTag, strongestAcross } from '@/standing.js'
import { isLiveStatus, stripeStatusByCustomer } from '@/subscriptionStatus.js'
import type { Bridge } from '@/types.js'
import { stackOf } from '@wizteros/server-common'

// Who a Stripe customer is in Wizarr, resolved live. Shared by the webhook
// handlers and the sweeps.

const log = new Logger('bridge')

/**
 * The evidence a member's identity is resolved from, read once per unit of
 * work: every Wizarr record and invitation, and the admin's links.
 *
 * /api/users is the slow call (~15s), so a handler loads this once and asks
 * it every question it has, rather than one lookup per guess.
 */
export const identitySnapshot = async (bridge: Bridge): Promise<IdentitySnapshot> => {
  const users = await bridge.wizarr.listUsers()
  const invitations = await bridge.wizarr.listInvitations()
  return { users, invitations, ...storedIdentity(bridge) }
}

/** The half of a snapshot the bridge's own store holds: the links, and each payer's invite. */
const storedIdentity = (bridge: Bridge): Pick<IdentitySnapshot, 'links' | 'invites'> => ({
  links: bridge.store.allMemberLinks(),
  invites: new Map(
    [...bridge.store.allCustomerRows()].flatMap(([email, row]) =>
      row.invite_code ? [[email, row.invite_code] as const] : [],
    ),
  ),
})

/**
 * A snapshot over Wizarr data already in hand, such as the members list's
 * warm one, for a caller that only needs to know who a person is rather than
 * which records they hold this second.
 */
export const snapshotOver = ({
  bridge,
  seen,
}: {
  bridge: Bridge
  seen: Pick<IdentitySnapshot, 'users' | 'invitations'>
}): IdentitySnapshot => ({
  users: seen.users,
  invitations: seen.invitations,
  ...storedIdentity(bridge),
})

/** The person behind any one of their addresses, with the invite stored against it followed. */
export const personAt = ({
  snapshot,
  email,
}: {
  snapshot: IdentitySnapshot
  email: string
}): Identity =>
  identityFor({ snapshot, email, inviteCode: snapshot.invites.get(email.toLowerCase()) ?? null })

/**
 * A snapshot from the store alone, for a caller that can do without Wizarr:
 * the admin's links still join a person's addresses, the invites cannot.
 */
export const storedSnapshot = (bridge: Bridge): IdentitySnapshot => ({
  users: [],
  invitations: [],
  ...storedIdentity(bridge),
})

/**
 * The tag that governs the person: the strongest one across all their
 * addresses. A sweep that asks for many people hands in the tags it read once.
 */
export const standingOf = ({
  bridge,
  identity,
  tags = bridge.store.allMemberTags(),
}: {
  bridge: Bridge
  identity: Identity
  tags?: ReadonlyMap<string, MemberTag>
}): MemberTag | null => strongestAcross({ tags, addresses: identity.addresses })

/**
 * Who a Stripe customer is in Wizarr, and the records they hold.
 *
 * The invite followed is the one stored against the customer, so a member
 * whose Plex account email differs from the Stripe email is still found.
 * `identityFor` says in which order the evidence is tried, and why.
 */
export const resolveIdentity = ({
  bridge,
  snapshot,
  customerId,
  email,
}: {
  bridge: Bridge
  snapshot: IdentitySnapshot
  customerId: string | null
  email: string | null
}): Identity => {
  const inviteCode = customerId
    ? (bridge.store.getMapping({ customerId })?.invite_code ?? null)
    : null
  const identity = identityFor({ snapshot, email, inviteCode })
  if (identity.via === 'link' && email) {
    log.log(
      `resolved ${email} through its linked address ${snapshot.links.get(email.toLowerCase()) ?? ''}`,
    )
  }
  return identity
}

/** The record ids a Stripe customer holds, resolved live from a fresh snapshot. */
export const resolveUserIds = async ({
  bridge,
  customerId,
  email,
}: {
  bridge: Bridge
  customerId: string | null
  email: string | null
}): Promise<number[]> => {
  const snapshot = await identitySnapshot(bridge)
  return resolveIdentity({ bridge, snapshot, customerId, email }).records.map((user) => user.id)
}

/** One sentence on whether the member can watch right now, for an alert body. */
export const accessLine = async ({
  bridge,
  customerId,
  email,
}: {
  bridge: Bridge
  customerId: string | null
  email: string
}): Promise<string> => {
  const held = await resolveUserIds({ bridge, customerId, email }).then(
    (ids) => ids.length > 0,
    (error: unknown) => {
      log.error(`could not read Wizarr records for ${email}`, stackOf(error))
      return null
    },
  )
  if (held === null) {
    return 'Whether they hold server access could not be checked (Wizarr unreachable).'
  }
  if (held) {
    return (
      'They still hold server access for the period already paid; it lapses ' +
      'at their expiry if the retries keep failing.'
    )
  }
  return (
    'They hold NO server access on any server right now: either their invite ' +
    'was never redeemed or their records already lapsed.'
  )
}

/**
 * Another Stripe customer at the same address that Stripe still says is paying.
 *
 * A member who re-checks out from scratch instead of fixing their card ends
 * up as two customers under one email: the old one dying in dunning, the new
 * one paying. `subscribed` is per email, so the store cannot tell the two
 * apart; Stripe can. One Stripe call, and only when a sibling row exists.
 */
export const liveSiblingCustomer = async ({
  bridge,
  email,
  deadCustomer,
}: {
  bridge: Bridge
  email: string
  deadCustomer: string
}): Promise<string | null> => {
  const siblings = bridge.store
    .customerIdsForEmail({ email })
    .filter((customer) => customer !== deadCustomer)
  if (siblings.length === 0) {
    return null
  }
  const status = await stripeStatusByCustomer(bridge.stripe)
  return siblings.find((customer) => isLiveStatus(status.get(customer) ?? '')) ?? null
}

/**
 * Another address of the same person still carrying a live subscription.
 *
 * A member can hold two Stripe customers, and only one of them dying is the
 * normal way that ends. Records resolve by email, so the dead customer's
 * address is the same one the live member watches under: disabling on its
 * cancellation revokes access somebody is currently paying for.
 */
export const stillSubscribedElsewhere = ({
  bridge,
  email,
  identity,
}: {
  bridge: Bridge
  email: string
  identity: Identity
}): string | null => {
  const rows = bridge.store.allCustomerRows()
  const lowered = email.toLowerCase()
  const others = [...identity.addresses].filter((address) => address !== lowered).toSorted()
  return others.find((address) => rows.get(address)?.subscribed ?? false) ?? null
}
