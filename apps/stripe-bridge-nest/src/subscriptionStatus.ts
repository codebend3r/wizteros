import type { StripeApi } from '@/types.js'

// What a Stripe subscription status means to the bridge, in one table.

/** An outstanding payment problem on a member: Stripe has a failed charge it is retrying. */
export type PaymentState = 'past_due'

type StatusRule = Readonly<{
  /** Whether Stripe is still charging for the subscription successfully. */
  live: boolean
  /**
   * How much the status counts when one customer holds several subscriptions
   * (an old canceled one next to the live one): the one that is paying, or
   * failing to, is the one that counts.
   */
  rank: number
  /** What the status means for the member's payment_state. */
  paymentState: PaymentState | null
}>

// A status absent here (canceled, incomplete, paused) ranks lowest and says
// nothing about payment_state: the end of a subscription belongs to the
// cancel handler.
const STATUS_RULES: ReadonlyMap<string, StatusRule> = new Map([
  ['active', { live: true, rank: 2, paymentState: null }],
  ['trialing', { live: true, rank: 2, paymentState: null }],
  ['past_due', { live: false, rank: 1, paymentState: 'past_due' }],
  ['unpaid', { live: false, rank: 1, paymentState: 'past_due' }],
])

/** What a status means, or undefined for one that says nothing about payment. */
export const statusRule = (status: string): StatusRule | undefined => STATUS_RULES.get(status)

/** Whether Stripe is still charging for a subscription in this status. */
export const isLiveStatus = (status: string): boolean => statusRule(status)?.live ?? false

const rank = (status: string | undefined): number => statusRule(status ?? '')?.rank ?? 0

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
