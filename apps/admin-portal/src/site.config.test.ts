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
