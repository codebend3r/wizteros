import { resolveConfig } from '@/site.config'

test('defines the four tiers in order with CAD prices', () => {
  const config = resolveConfig({ env: {} })
  expect(config.tiers.map((tier) => tier.id)).toEqual(['bronze', 'silver', 'gold', 'kids'])
  expect(config.tiers.map((tier) => tier.price)).toEqual(['$8', '$14', '$20', '$10'])
  config.tiers.forEach((tier) => expect(tier.cadence).toBe('CAD / month'))
})

test('every tier lists the same five features in order', () => {
  const config = resolveConfig({ env: {} })
  config.tiers.forEach((tier) =>
    expect(tier.features.map((feature) => feature.label)).toEqual([
      'Access to all 1080p libraries',
      'Access to all 4K libraries',
      'Access to Lossless Music Library',
      'Offline downloads for travel',
      'Request any show or movie',
    ]),
  )
})

test('only gold includes the lossless music library', () => {
  const config = resolveConfig({ env: {} })
  const byId = Object.fromEntries(
    config.tiers.map((tier) => [
      tier.id,
      tier.features.some(
        ({ label, included }) => label === 'Access to Lossless Music Library' && included,
      ),
    ]),
  )
  expect(byId).toEqual({ bronze: false, silver: false, gold: true, kids: false })
})

test('tier payment links fall back to empty strings with empty env', () => {
  const config = resolveConfig({ env: {} })
  config.tiers.forEach((tier) => expect(tier.paymentLinkUrl).toBe(''))
})

test('maps each payment link env var to its tier', () => {
  const config = resolveConfig({
    env: {
      VITE_PAYMENT_LINK_BRONZE_URL: 'https://buy.stripe.com/b',
      VITE_PAYMENT_LINK_SILVER_URL: 'https://buy.stripe.com/s',
      VITE_PAYMENT_LINK_GOLD_URL: 'https://buy.stripe.com/g',
      VITE_PAYMENT_LINK_KIDS_URL: 'https://buy.stripe.com/k',
    },
  })
  const byId = Object.fromEntries(config.tiers.map((tier) => [tier.id, tier.paymentLinkUrl]))
  expect(byId).toEqual({
    bronze: 'https://buy.stripe.com/b',
    silver: 'https://buy.stripe.com/s',
    gold: 'https://buy.stripe.com/g',
    kids: 'https://buy.stripe.com/k',
  })
})

test('uses the member url from env when set', () => {
  const config = resolveConfig({ env: { VITE_MEMBER_URL: 'https://invite.example.com' } })
  expect(config.memberUrl).toBe('https://invite.example.com')
})

test('provides three support items', () => {
  const config = resolveConfig({ env: {} })
  expect(config.supportItems).toHaveLength(3)
})
