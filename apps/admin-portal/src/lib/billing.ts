import type { Tier } from '@/site.config'

export type BillingCadence = 'monthly' | 'annual'

export type AnnualPricing = {
  total: string
  perMonth: string
  cadence: string
  savings: string
  headline: string
  paymentLinkUrl: string
}

// Annual charges ten months up front and covers the remaining two. Two months
// free is 16.7% off, which sits inside the 15-25% band the field treats as a
// real incentive: below ~10% nobody prepays, above ~25% the monthly price
// starts to read as a penalty and people learn to wait for a discount.
export const ANNUAL_MONTHS_CHARGED = 10
const MONTHS_PER_YEAR = 12
export const ANNUAL_MONTHS_FREE = MONTHS_PER_YEAR - ANNUAL_MONTHS_CHARGED

export const amountOf = (price: string): number => Number(price.replace(/[^0-9.]/g, ''))

const dollars = (amount: number): string =>
  `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`

// Derived, never hand-written, so the annual figures cannot drift from the
// monthly ones the tier already carries.
export const toAnnualPricing = ({
  price,
  paymentLinkUrl,
}: {
  price: string
  paymentLinkUrl: string
}): AnnualPricing => {
  const monthly = amountOf(price)
  const total = monthly * ANNUAL_MONTHS_CHARGED
  return {
    total: dollars(total),
    perMonth: dollars(Math.round((total / MONTHS_PER_YEAR) * 100) / 100),
    cadence: 'CAD / month, billed annually',
    savings: `Save ${dollars(monthly * ANNUAL_MONTHS_FREE)} a year`,
    headline: `${ANNUAL_MONTHS_FREE} months free`,
    paymentLinkUrl,
  }
}

// What a single month of the tier costs under the chosen cadence: the sticker
// price monthly, the annual total spread back over twelve months on annual.
// The cost ledger splits this, so it stays a per-month figure either way.
export const monthlyAmount = ({ tier, cadence }: { tier: Tier; cadence: BillingCadence }): number =>
  amountOf(cadence === 'annual' ? tier.annual.perMonth : tier.price)

export const monthlyPrice = ({ tier, cadence }: { tier: Tier; cadence: BillingCadence }): string =>
  cadence === 'annual' ? tier.annual.perMonth : tier.price

// "From $8": the cheapest tier under the current cadence anchors the marquee.
export const fromPrice = ({
  tiers,
  cadence,
}: {
  tiers: ReadonlyArray<Tier>
  cadence: BillingCadence
}): string =>
  tiers.reduce(
    (cheapest, tier) =>
      monthlyAmount({ tier, cadence }) < amountOf(cheapest)
        ? monthlyPrice({ tier, cadence })
        : cheapest,
    tiers[0] ? monthlyPrice({ tier: tiers[0], cadence }) : '$8',
  )
