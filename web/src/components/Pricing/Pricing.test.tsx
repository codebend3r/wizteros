import { render, screen } from '@testing-library/react'
import Pricing from '@/components/Pricing/Pricing'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'bronze',
    name: 'Bronze',
    priceLabel: '$8 CAD / month',
    features: ['Standard streaming quality'],
    paymentLinkUrl: 'https://buy.stripe.com/test_bronze',
  },
  {
    id: 'gold',
    name: 'Gold',
    priceLabel: '$20 CAD / month',
    features: ['Offline downloads'],
    paymentLinkUrl: '',
  },
]

test('renders a card per tier with price and features', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByText('$8 CAD / month')).toBeInTheDocument()
  expect(screen.getByText('Standard streaming quality')).toBeInTheDocument()
})

test('links the CTA to the tier payment link', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('link', { name: 'Choose Bronze' })).toHaveAttribute(
    'href',
    'https://buy.stripe.com/test_bronze',
  )
})

test('hides the CTA when the payment link is not configured', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.queryByRole('link', { name: 'Choose Gold' })).toBeNull()
})
