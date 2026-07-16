import { render, screen } from '@testing-library/react'
import Pricing from '@/components/Pricing/Pricing'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'bronze',
    name: 'Bronze',
    price: '$8',
    cadence: 'CAD / month',
    features: ['Standard streaming quality'],
    paymentLinkUrl: 'https://buy.stripe.com/test_bronze',
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$20',
    cadence: 'CAD / month',
    features: ['Offline downloads'],
    paymentLinkUrl: '',
  },
]

test('renders the section header', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Choose your tier' })).toBeInTheDocument()
})

test('renders a card per tier with price, cadence, and features', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByText('$8')).toBeInTheDocument()
  expect(screen.getAllByText('CAD / month')).toHaveLength(2)
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
