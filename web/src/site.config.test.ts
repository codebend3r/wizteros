import { resolveConfig, DEFAULT_PAYMENT_LINK_URL } from '@/site.config'

test('falls back to the default payment link and null member url with empty env', () => {
  const config = resolveConfig({ env: {} })
  expect(config.paymentLinkUrl).toBe(DEFAULT_PAYMENT_LINK_URL)
  expect(config.memberUrl).toBeNull()
})

test('uses the payment link from env when set', () => {
  const config = resolveConfig({
    env: { VITE_PAYMENT_LINK_URL: 'https://buy.stripe.com/live_abc' },
  })
  expect(config.paymentLinkUrl).toBe('https://buy.stripe.com/live_abc')
})

test('uses the member url from env when set', () => {
  const config = resolveConfig({ env: { VITE_MEMBER_URL: 'https://invite.example.com' } })
  expect(config.memberUrl).toBe('https://invite.example.com')
})

test('provides three support items', () => {
  const config = resolveConfig({ env: {} })
  expect(config.supportItems).toHaveLength(3)
})
