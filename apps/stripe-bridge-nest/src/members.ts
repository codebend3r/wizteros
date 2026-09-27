import { Logger } from '@nestjs/common'
import { customerIdsForEmail, getMapping, getMemberLink } from '@/store.js'
import type { StripeApi, WizarrApi } from '@/types.js'
import { stackOf } from '@/errors.js'

// Who a Stripe customer is in Wizarr, resolved live.
//
// Shared by the webhook handlers and the sweeps, which is why it takes the
// Wizarr port and the store path as arguments instead of reaching for the
// bridge's own.

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
  wizarr,
  dbPath,
  customerId,
  email,
}: {
  wizarr: WizarrApi
  dbPath: string
  customerId: string | null
  email: string | null
}): Promise<number[]> => {
  const byEmail = email ? await wizarr.findUserIdsByEmail(email) : []
  if (byEmail.length > 0 || !email) {
    return byEmail.length > 0 || !customerId ? byEmail : fromInvite({ wizarr, dbPath, customerId })
  }
  const linked = getMemberLink({ path: dbPath, stripeEmail: email })
  const byLink = linked ? await wizarr.findUserIdsByEmail(linked) : []
  if (byLink.length > 0) {
    log.log(`resolved ${email} through its linked address ${linked}`)
    return byLink
  }
  return customerId ? fromInvite({ wizarr, dbPath, customerId }) : []
}

/** The records that redeemed the invite stored against a customer, or none. */
const fromInvite = async ({
  wizarr,
  dbPath,
  customerId,
}: {
  wizarr: WizarrApi
  dbPath: string
  customerId: string
}): Promise<number[]> => {
  const mapping = getMapping({ path: dbPath, customerId })
  const code = mapping?.invite_code ?? null
  return code ? wizarr.findUserIdsByInvite(code) : []
}

/** One sentence on whether the member can watch right now, for an alert body. */
export const accessLine = async ({
  wizarr,
  dbPath,
  customerId,
  email,
}: {
  wizarr: WizarrApi
  dbPath: string
  customerId: string | null
  email: string
}): Promise<string> => {
  const held = await resolveUserIds({ wizarr, dbPath, customerId, email }).then(
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

/** A subscription Stripe is still charging for, or trying to. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing'])

// When one customer holds several subscriptions (an old canceled one next to
// the live one), the one that is paying, or failing to, is the one that counts.
const SUB_STATUS_RANK: ReadonlyMap<string, number> = new Map([
  ['active', 2],
  ['trialing', 2],
  ['past_due', 1],
  ['unpaid', 1],
])

const rank = (status: string | undefined): number => SUB_STATUS_RANK.get(status ?? '') ?? 0

/** Every customer's best subscription status, straight from Stripe. */
export const stripeStatusByCustomer = async (
  stripe: StripeApi,
): Promise<ReadonlyMap<string, string>> => {
  const subscriptions = await stripe.allSubscriptions()
  const best = (customer: string): string | undefined =>
    subscriptions
      .filter((subscription) => subscription.customer === customer)
      .reduce<string | undefined>(
        (current, { status }) => (rank(status) > rank(current) ? status : current),
        undefined,
      )
  return new Map(
    [...new Set(subscriptions.map(({ customer }) => customer))].flatMap(
      (customer): [string, string][] => {
        const status = best(customer)
        return status === undefined ? [] : [[customer, status]]
      },
    ),
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
  stripe,
  dbPath,
  email,
  deadCustomer,
}: {
  stripe: StripeApi
  dbPath: string
  email: string
  deadCustomer: string
}): Promise<string | null> => {
  const siblings = customerIdsForEmail({ path: dbPath, email }).filter(
    (customer) => customer !== deadCustomer,
  )
  if (siblings.length === 0) {
    return null
  }
  const status = await stripeStatusByCustomer(stripe)
  return siblings.find((customer) => LIVE_STATUSES.has(status.get(customer) ?? '')) ?? null
}
