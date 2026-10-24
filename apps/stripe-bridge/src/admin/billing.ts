import { Logger } from '@nestjs/common'
import { isoformat, stackOf } from '@wizteros/server-common'
import type { BanResult } from '@wizteros/wire'
import { mapInOrder } from '@/sequence.js'
import type { Bridge, StripeSubscription } from '@/types.js'

const log = new Logger('bridge.admin.billing')

type Flagged = Readonly<{
  found: boolean
  flagged: readonly StripeSubscription[]
  already: readonly StripeSubscription[]
  failures: number
}>

/** A failed remote operation cannot erase successful work or stop the next account. */
const attempt = async <T>({
  label,
  run,
}: {
  label: string
  run: () => Promise<T>
}): Promise<T | null> => {
  try {
    return await run()
  } catch (error) {
    log.error(label, stackOf(error))
    return null
  }
}

export const cancelAtOf = (subscriptions: readonly StripeSubscription[]): string | null => {
  const latest = subscriptions.reduce((max, sub) => Math.max(max, sub.cancel_at ?? 0), 0)
  return latest ? isoformat(new Date(latest * 1000)) : null
}

/** All calls stay ordered; each failure is retained alongside successful cancellations. */
export const flagSubscriptions = async ({
  bridge,
  addresses,
}: {
  bridge: Bridge
  addresses: readonly string[]
}): Promise<Flagged> => {
  const perAddress = await mapInOrder({
    items: addresses,
    run: async (address) => {
      const mapped = bridge.store.customerIdsForEmail({ email: address })
      return mapped.length > 0
        ? mapped
        : attempt({
            label: `could not find Stripe customers for ${address}`,
            run: () => bridge.stripe.customerIdsForEmail(address),
          })
    },
  })
  const customerIds = [...new Set(perAddress.flatMap((ids) => ids ?? []))]
  const perCustomer = await mapInOrder({
    items: customerIds,
    run: async (customerId) => {
      const subscriptions = await attempt({
        label: `could not list subscriptions for ${customerId}`,
        run: () => bridge.stripe.subscriptionsFor(customerId),
      })
      if (subscriptions === null) return { flagged: [], already: [], failures: 1 }
      const already = subscriptions.filter((sub) => sub.cancel_at_period_end)
      const results = await mapInOrder({
        items: subscriptions.filter((sub) => !sub.cancel_at_period_end),
        run: (sub) =>
          attempt({
            label: `could not schedule cancellation for ${sub.id}`,
            run: () => bridge.stripe.cancelAtPeriodEnd(sub.id),
          }),
      })
      return {
        flagged: results.flatMap((sub) => (sub === null ? [] : [sub])),
        already,
        failures: results.filter((sub) => sub === null).length,
      }
    },
  })
  return {
    found: customerIds.length > 0,
    flagged: perCustomer.flatMap(({ flagged }) => flagged),
    already: perCustomer.flatMap(({ already }) => already),
    failures:
      perAddress.filter((ids) => ids === null).length +
      perCustomer.reduce((sum, result) => sum + result.failures, 0),
  }
}

export const banBillingOutcome = ({
  flagged,
  already,
  failures,
}: Flagged): Pick<BanResult, 'billing_status' | 'canceled' | 'cancel_at'> => ({
  billing_status:
    failures > 0
      ? flagged.length + already.length > 0
        ? 'partial'
        : 'failed'
      : flagged.length > 0
        ? 'scheduled'
        : already.length > 0
          ? 'already_scheduled'
          : 'absent',
  canceled: flagged.length,
  cancel_at: cancelAtOf([...flagged, ...already]),
})

export const banBillingLine = (
  billing: Pick<BanResult, 'billing_status' | 'cancel_at'>,
): string => {
  if (billing.billing_status === 'failed')
    return 'could not reach Stripe, cancel the subscription by hand'
  if (billing.billing_status === 'partial')
    return 'some cancellations failed; check remaining subscriptions in Stripe'
  if (billing.billing_status === 'absent') return 'no subscription to cancel'
  return billing.cancel_at
    ? `billing stops ${billing.cancel_at.slice(0, 10)}`
    : 'cancellation scheduled'
}
