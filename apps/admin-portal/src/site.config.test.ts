import { expect, test } from '@/test/vi'
import { resolveConfig } from '@/site.config'

test('defines the four tiers in order with CAD prices', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.id)).toEqual(['bronze', 'silver', 'gold', 'youth'])
  expect(config.tiers.map((tier) => tier.price)).toEqual(['$8', '$14', '$20', '$10'])
  expect(config.tiers.map((tier) => tier.cadence)).toEqual(config.tiers.map(() => 'CAD / month'))
})

test('adult tiers list the same five features; youth swaps in youth-profile playback rows', () => {
  const config = resolveConfig({ env: {} })
  const labelsById = Object.fromEntries(
    config.tiers.map((tier) => [tier.id, tier.features.map((feature) => feature.label)]),
  )
  const adultLabels = [
    '1080p HD streaming',
    '4K UHD streaming',
    'Lossless audio streaming',
    'Offline downloads for travel',
    'Access to the request queue',
  ]
  expect(labelsById.bronze).toEqual(adultLabels)
  expect(labelsById.silver).toEqual(adultLabels)
  expect(labelsById.gold).toEqual(adultLabels)
  expect(labelsById.youth).toEqual([
    '1080p HD streaming (youth profile)',
    '4K UHD streaming (youth profile)',
    'Lossless audio streaming',
    'Offline downloads for travel',
    'Access to the request queue',
  ])
})

test('every tier except youth includes lossless audio streaming', () => {
  const config = resolveConfig({ env: {} })
  const byId = Object.fromEntries(
    config.tiers.map((tier) => [
      tier.id,
      tier.features.some(({ label, included }) => label === 'Lossless audio streaming' && included),
    ]),
  )
  expect(byId).toEqual({ bronze: true, silver: true, gold: true, youth: false })
})

test('tier payment links fall back to empty strings with empty env', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.paymentLinkUrl)).toEqual(config.tiers.map(() => ''))
})

test('maps each payment link env var to its tier', () => {
  const config = resolveConfig({
    env: {
      VITE_PAYMENT_LINK_BRONZE_URL: 'https://buy.stripe.com/b',
      VITE_PAYMENT_LINK_SILVER_URL: 'https://buy.stripe.com/s',
      VITE_PAYMENT_LINK_GOLD_URL: 'https://buy.stripe.com/g',
      VITE_PAYMENT_LINK_YOUTH_URL: 'https://buy.stripe.com/k',
    },
  })
  const byId = Object.fromEntries(config.tiers.map((tier) => [tier.id, tier.paymentLinkUrl]))
  expect(byId).toEqual({
    bronze: 'https://buy.stripe.com/b',
    silver: 'https://buy.stripe.com/s',
    gold: 'https://buy.stripe.com/g',
    youth: 'https://buy.stripe.com/k',
  })
})

test('uses the member url from env when set', () => {
  const config = resolveConfig({ env: { VITE_MEMBER_URL: 'https://invite.example.com' } })
  expect(config.memberUrl).toBe('https://invite.example.com')
})

test('uses the billing portal url from env when set, null otherwise', () => {
  const config = resolveConfig({
    env: { VITE_BILLING_PORTAL_URL: 'https://billing.stripe.com/p/login/x' },
  })
  expect(config.billingPortalUrl).toBe('https://billing.stripe.com/p/login/x')
  expect(resolveConfig({ env: {} }).billingPortalUrl).toBeNull()
})

test('uses the stripe dashboard url from env when set, null otherwise', () => {
  const config = resolveConfig({
    env: { VITE_STRIPE_DASHBOARD_URL: 'https://dashboard.stripe.com/acct_1' },
  })
  expect(config.stripeDashboardUrl).toBe('https://dashboard.stripe.com/acct_1')
  expect(resolveConfig({ env: {} }).stripeDashboardUrl).toBeNull()
})

test('provides three support items', () => {
  const config = resolveConfig({ env: {} })
  expect(config.supportItems).toHaveLength(3)
})

test('derives an annual column from every tier price at two months free', () => {
  const config = resolveConfig({ env: {} })
  const byId = Object.fromEntries(
    config.tiers.map((tier) => [
      tier.id,
      { total: tier.annual.total, perMonth: tier.annual.perMonth, savings: tier.annual.savings },
    ]),
  )
  expect(byId).toEqual({
    bronze: { total: '$80', perMonth: '$6.67', savings: 'Save $16 a year' },
    silver: { total: '$140', perMonth: '$11.67', savings: 'Save $28 a year' },
    gold: { total: '$200', perMonth: '$16.67', savings: 'Save $40 a year' },
    youth: { total: '$100', perMonth: '$8.33', savings: 'Save $20 a year' },
  })
})

test('labels every annual card as billed annually', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.annual.cadence)).toEqual(
    config.tiers.map(() => 'CAD / month, billed annually'),
  )
})

test('annual payment links fall back to empty strings with empty env', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.annual.paymentLinkUrl)).toEqual(config.tiers.map(() => ''))
})

test('maps each annual payment link env var to its tier', () => {
  const config = resolveConfig({
    env: {
      VITE_PAYMENT_LINK_BRONZE_ANNUAL_URL: 'https://buy.stripe.com/by',
      VITE_PAYMENT_LINK_SILVER_ANNUAL_URL: 'https://buy.stripe.com/sy',
      VITE_PAYMENT_LINK_GOLD_ANNUAL_URL: 'https://buy.stripe.com/gy',
      VITE_PAYMENT_LINK_YOUTH_ANNUAL_URL: 'https://buy.stripe.com/ky',
    },
  })
  const byId = Object.fromEntries(config.tiers.map((tier) => [tier.id, tier.annual.paymentLinkUrl]))
  expect(byId).toEqual({
    bronze: 'https://buy.stripe.com/by',
    silver: 'https://buy.stripe.com/sy',
    gold: 'https://buy.stripe.com/gy',
    youth: 'https://buy.stripe.com/ky',
  })
})

test('keeps the monthly and annual links apart on the same tier', () => {
  const config = resolveConfig({
    env: {
      VITE_PAYMENT_LINK_GOLD_URL: 'https://buy.stripe.com/g',
      VITE_PAYMENT_LINK_GOLD_ANNUAL_URL: 'https://buy.stripe.com/gy',
    },
  })
  const gold = config.tiers.find((tier) => tier.id === 'gold')
  expect(gold?.paymentLinkUrl).toBe('https://buy.stripe.com/g')
  expect(gold?.annual.paymentLinkUrl).toBe('https://buy.stripe.com/gy')
})
