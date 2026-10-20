import { Logger } from '@nestjs/common'
import { type Identity, type IdentitySnapshot, identityFor } from '@/identity.js'
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
  return { users, invitations, links: bridge.store.allMemberLinks() }
}

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
 * Every address belonging to the same person as `email`, lowercased.
 *
 * Links point payer -> Plex account, so the person is identified by the Plex
 * address: either this address pays for someone (follow the link) or it is
 * the account itself. Both directions matter, since a cancellation can land
 * on either half of the pair.
 */
export const linkedAddresses = ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): ReadonlySet<string> => {
  const links = bridge.store.allMemberLinks()
  const lowered = email.toLowerCase()
  const owner = links.get(lowered) ?? lowered
  return new Set([
    owner,
    ...[...links].filter(([, plex]) => plex === owner).map(([payer]) => payer),
  ])
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
}: {
  bridge: Bridge
  email: string
}): string | null => {
  const rows = bridge.store.allCustomerRows()
  const lowered = email.toLowerCase()
  const others = [...linkedAddresses({ bridge, email })]
    .filter((address) => address !== lowered)
    .toSorted()
  return others.find((address) => rows.get(address)?.subscribed ?? false) ?? null
}
