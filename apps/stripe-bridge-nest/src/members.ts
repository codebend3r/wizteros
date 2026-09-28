import { Logger } from '@nestjs/common'
import { isLiveStatus, stripeStatusByCustomer } from '@/subscriptionStatus.js'
import type { Bridge } from '@/types.js'
import { stackOf } from '@/errors.js'

// Who a Stripe customer is in Wizarr, resolved live. Shared by the webhook
// handlers and the sweeps.

const log = new Logger('bridge')

/**
 * All Wizarr record ids for a member (one per server), resolved live.
 *
 * Prefer email, then the address an admin linked this one to, then the
 * stored invite code (the Stripe email may differ from the Plex account
 * email). The linked address comes second on purpose: it is a stated fact
 * about who this customer is, while the invite code only infers it from a
 * redemption. It is also the only thing that answers for a member who
 * re-subscribed under a re-typed address without ever redeeming the invite
 * that checkout issued: their renewal would otherwise find nothing to extend
 * and mint yet another invite they have no reason to click.
 */
export const resolveUserIds = async ({
  bridge,
  customerId,
  email,
}: {
  bridge: Bridge
  customerId: string | null
  email: string | null
}): Promise<number[]> => {
  const byEmail = email ? await bridge.wizarr.findUserIdsByEmail(email) : []
  if (byEmail.length > 0 || !email) {
    return byEmail.length > 0 || !customerId ? byEmail : fromInvite({ bridge, customerId })
  }
  const linked = bridge.store.getMemberLink({ stripeEmail: email })
  const byLink = linked ? await bridge.wizarr.findUserIdsByEmail(linked) : []
  if (byLink.length > 0) {
    log.log(`resolved ${email} through its linked address ${linked}`)
    return byLink
  }
  return customerId ? fromInvite({ bridge, customerId }) : []
}

/** The records that redeemed the invite stored against a customer, or none. */
const fromInvite = async ({
  bridge,
  customerId,
}: {
  bridge: Bridge
  customerId: string
}): Promise<number[]> => {
  const code = bridge.store.getMapping({ customerId })?.invite_code ?? null
  return code ? bridge.wizarr.findUserIdsByInvite(code) : []
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
