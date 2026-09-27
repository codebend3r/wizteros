import { Stripe } from 'stripe'
import type { StripeApi, StripeSubscription } from '@/types.js'

// The API version the production Python bridge sent: stripe-python 15.3.1 on
// the NAS, checked 2026-09-27. stripe@22.3.2 is the SDK release pinned to
// exactly this version, so every outgoing call keeps the shapes the Python
// bridge sent and read.
export const STRIPE_API_VERSION = '2026-06-24.dahlia'

/**
 * The subscription fields `toSubscription` reads. The SDK's `Subscription`
 * satisfies it; a test can build one without the other hundred fields.
 */
export type SdkSubscription = Readonly<{
  id: string
  status: string
  cancel_at_period_end: boolean
  cancel_at?: number | null
  /** An id, or the customer (possibly deleted) when it was expanded. */
  customer: string | Readonly<{ id: string }>
}>

/** The fields the bridge reads off an SDK subscription. */
export const toSubscription = (subscription: SdkSubscription): StripeSubscription => ({
  id: subscription.id,
  customer:
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
  status: subscription.status,
  cancel_at_period_end: subscription.cancel_at_period_end,
  cancel_at: subscription.cancel_at ?? null,
})

/**
 * Every item of an auto-paginated list, page after page, as the Python's
 * `.auto_paging_iter()` walked it. Recursion stands in for a `for await` loop.
 */
const drain = async <T>({
  items,
  seen = [],
}: {
  items: AsyncIterator<T>
  seen?: readonly T[]
}): Promise<readonly T[]> => {
  const next = await items.next()
  return next.done ? seen : drain({ items, seen: [...seen, next.value] })
}

/** Every subscription an auto-paginated list yields, mapped to the bridge's shape. */
const allPages = async (list: AsyncIterable<Stripe.Subscription>): Promise<StripeSubscription[]> =>
  (await drain({ items: list[Symbol.asyncIterator]() })).map(toSubscription)

/** The Stripe calls the bridge makes, over an SDK client pinned to STRIPE_API_VERSION. */
export const stripeApi = ({ apiKey }: { apiKey: string }): StripeApi => {
  const stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION })
  return {
    /**
     * The email on a customer record; null for a deleted customer or one with
     * no email on file (Python's `getattr(customer, "email", None)`).
     */
    customerEmail: async (customerId) => {
      const customer = await stripe.customers.retrieve(customerId)
      return customer.deleted === true ? null : customer.email || null
    },

    /** The first customer Stripe's search finds for an email, or null. */
    searchCustomerId: async (email) => {
      const found = await stripe.customers.search({ query: `email:'${email}'`, limit: 1 })
      return found.data[0]?.id ?? null
    },

    /** Every customer id Stripe lists for an email: one page of up to 100, as Python read. */
    customerIdsForEmail: async (email) =>
      (await stripe.customers.list({ email, limit: 100 })).data.map((customer) => customer.id),

    /** Every subscription a customer holds, all pages. */
    subscriptionsFor: (customerId) => allPages(stripe.subscriptions.list({ customer: customerId })),

    /** Flag a subscription to cancel at period end; returns it as updated. */
    cancelAtPeriodEnd: async (subscriptionId) =>
      toSubscription(
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }),
      ),

    /** Every subscription on the account in any status, all pages. */
    allSubscriptions: () => allPages(stripe.subscriptions.list({ status: 'all', limit: 100 })),
  }
}

/**
 * Check a webhook's `Stripe-Signature` against the raw request bytes.
 *
 * Uses the SDK's static verifier, so no API key is involved. Throws when the
 * signature is missing, malformed, stale or wrong (a
 * `StripeSignatureVerificationError`), and when a correctly signed payload is
 * not JSON (a `SyntaxError`); returns nothing when the event is genuine. The
 * webhook route answers those two cases, which `isSignatureError` names, with a
 * 400 "invalid signature", as the Python's
 * `except (ValueError, stripe.error.SignatureVerificationError)` did; anything
 * else it throws is left to fail the delivery as a 500.
 */
export const verifyWebhook = ({
  payload,
  signature,
  secret,
}: {
  payload: Buffer
  signature: string | null | undefined
  secret: string
}): void => {
  Stripe.webhooks.constructEvent(payload, signature ?? '', secret)
}

/**
 * Whether `error` is one `verifyWebhook` raises for a request that is not a
 * genuine Stripe event: a failed signature check or an unparseable payload,
 * the pair Python caught as SignatureVerificationError and ValueError.
 */
export const isSignatureError = (error: unknown): boolean =>
  error instanceof Stripe.errors.StripeSignatureVerificationError || error instanceof SyntaxError
