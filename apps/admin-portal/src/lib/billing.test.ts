import { expect, test } from '@/test/vi'
import {
  ANNUAL_MONTHS_CHARGED,
  ANNUAL_MONTHS_FREE,
  amountOf,
  fromPrice,
  monthlyAmount,
  monthlyPrice,
  toAnnualPricing,
} from '@/lib/billing'
import type { Tier } from '@/site.config'

const tierAt = ({ id, price }: { id: Tier['id']; price: string }): Tier => ({
  id,
  name: id,
  price,
  cadence: 'CAD / month',
  summary: '',
  features: [],
  paymentLinkUrl: '',
  annual: toAnnualPricing({ price, paymentLinkUrl: '' }),
})

test('charges ten of twelve months, leaving two free', () => {
  expect(ANNUAL_MONTHS_CHARGED).toBe(10)
  expect(ANNUAL_MONTHS_FREE).toBe(2)
})

test('reads the numeric amount out of a formatted price', () => {
  expect(amountOf('$8')).toBe(8)
  expect(amountOf('$11.67')).toBe(11.67)
})

test('derives the annual column from the monthly price', () => {
  expect(toAnnualPricing({ price: '$14', paymentLinkUrl: '' })).toEqual({
    total: '$140',
    perMonth: '$11.67',
    cadence: 'CAD / month, billed annually',
    savings: 'Save $28 a year',
    headline: '2 months free',
    paymentLinkUrl: '',
  })
})

test('keeps the annual total in whole dollars for every shipped tier price', () => {
  const totals = ['$8', '$10', '$14', '$20'].map(
    (price) => toAnnualPricing({ price, paymentLinkUrl: '' }).total,
  )
  expect(totals).toEqual(['$80', '$100', '$140', '$200'])
})

test('carries the annual payment link through untouched', () => {
  expect(
    toAnnualPricing({ price: '$20', paymentLinkUrl: 'https://buy.stripe.com/y' }).paymentLinkUrl,
  ).toBe('https://buy.stripe.com/y')
})

test('the saving is one sixth of the year, within a dollar of a twelfth times two', () => {
  const monthly = amountOf('$20')
  const annual = toAnnualPricing({ price: '$20', paymentLinkUrl: '' })
  expect(monthly * 12 - amountOf(annual.total)).toBe(amountOf(annual.savings.replace('Save ', '')))
})

test('reports the per-month cost under each cadence', () => {
  const tier = tierAt({ id: 'silver', price: '$14' })
  expect(monthlyAmount({ tier, cadence: 'monthly' })).toBe(14)
  expect(monthlyAmount({ tier, cadence: 'annual' })).toBe(11.67)
  expect(monthlyPrice({ tier, cadence: 'monthly' })).toBe('$14')
  expect(monthlyPrice({ tier, cadence: 'annual' })).toBe('$11.67')
})

test('anchors the marquee on the cheapest tier under the current cadence', () => {
  const tiers = [tierAt({ id: 'silver', price: '$14' }), tierAt({ id: 'bronze', price: '$8' })]
  expect(fromPrice({ tiers, cadence: 'monthly' })).toBe('$8')
  expect(fromPrice({ tiers, cadence: 'annual' })).toBe('$6.67')
})
