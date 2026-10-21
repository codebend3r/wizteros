import { Logger } from '@nestjs/common'
import { stackOf } from '@wizteros/server-common'
import { duplicatesRetired, type RetiredSubscription } from '@/alerts.js'
import { mapInOrder } from '@/sequence.js'
import { isDunningStatus } from '@/subscriptionStatus.js'
import type { Bridge } from '@/types.js'

// A member whose card fails often checks out again from scratch instead of
// fixing it. That leaves two Stripe customers at one address: the new one
// paying, the old one still in dunning, and Stripe's next retry on the old one
// charges them twice for the same access. Danny did it twice (2026-09-18 and
// 2026-10-19), and both times the old subscription was cancelled by hand.

const log = new Logger('bridge')

/** How a retirement went: what was cancelled, nothing to cancel, or Stripe failed. */
export type Retirement = Readonly<
  | { status: 'retired'; retired: readonly RetiredSubscription[] }
  | { status: 'none' }
  | { status: 'failed' }
>

/** Cancel each dunning subscription, then void the invoices it leaves open. */
const cancelAndVoid = async ({
  bridge,
  email,
  payingUnder,
}: {
  bridge: Bridge
  email: string
  payingUnder: string
}): Promise<readonly RetiredSubscription[]> => {
  const others = (await bridge.stripe.customerIdsForEmail(email)).filter(
    (customer) => customer !== payingUnder,
  )
  const dunning = (
    await mapInOrder({ items: others, run: (customer) => bridge.stripe.subscriptionsFor(customer) })
  )
    .flat()
    .filter((subscription) => isDunningStatus(subscription.status))
  // Cancel before voiding. A void that then fails leaves an open invoice on a
  // cancelled subscription, which the failure alert names; voiding first
  // could flip the subscription back to active and keep it billing unseen.
  return mapInOrder({
    items: dunning,
    run: async ({ id, customer }): Promise<RetiredSubscription> => {
      await bridge.stripe.cancelNow(id)
      const invoices = await bridge.stripe.openInvoiceIds(id)
      await mapInOrder({ items: invoices, run: (invoice) => bridge.stripe.voidInvoice(invoice) })
      return { subscription: id, customer, invoices }
    },
  })
}

/**
 * Cancel every subscription at `email` that Stripe is still retrying, other
 * than `payingUnder`'s, and void its open invoices. A retirement is recorded
 * and alerted here; what a failure or an empty result means is the caller's
 * call. Never throws, because both callers run after the work their event
 * exists for is done.
 *
 * Callers must only name a `payingUnder` the store maps to `email`: the cancel
 * fires customer.subscription.deleted, and that handler keeps the member's
 * access only because it finds this live sibling in the store.
 */
export const retireDuplicates = async ({
  bridge,
  email,
  payingUnder,
}: {
  bridge: Bridge
  email: string
  payingUnder: string
}): Promise<Retirement> => {
  const retired = await cancelAndVoid({ bridge, email, payingUnder }).catch((error: unknown) => {
    log.error(`could not retire duplicate subscriptions for ${email}`, stackOf(error))
    return null
  })
  if (retired === null) {
    return { status: 'failed' }
  }
  if (retired.length === 0) {
    return { status: 'none' }
  }
  const ids = retired.map(({ subscription }) => subscription).join(', ')
  log.log(`retired duplicate subscription(s) ${ids} for ${email}; pays under ${payingUnder}`)
  bridge.store.recordEvent({
    email,
    action: 'Duplicate cancelled',
    detail: `${ids} cancelled and voided; pays under ${payingUnder}`,
  })
  await bridge.mailer.sendAlert(duplicatesRetired({ email, payingUnder, retired }))
  return { status: 'retired', retired }
}
