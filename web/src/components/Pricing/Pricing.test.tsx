import { expect, test } from '@/test/vi'
import { render, screen, within } from '@testing-library/react'
import Pricing from '@/components/Pricing/Pricing'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'bronze',
    name: 'Bronze',
    price: '$8',
    cadence: 'CAD / month',
    summary: 'The essentials to get streaming.',
    features: [
      { label: 'Access to all 1080p libraries', included: true },
      { label: 'Access to all 4K libraries', included: false },
    ],
    paymentLinkUrl: 'https://buy.stripe.com/test_bronze',
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$20',
    cadence: 'CAD / month',
    summary: 'Everything the server offers.',
    features: [{ label: 'Offline downloads for travel', included: true }],
    paymentLinkUrl: '',
  },
]

const getFeatureRow = ({ label }: { label: string }): HTMLLIElement => {
  const row = screen.getByText(label).closest('li')
  if (!row) throw new Error(`No feature row found for "${label}"`)
  return row
}

test('renders the section header', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Choose your tier' })).toBeInTheDocument()
})

test('renders a card per tier with price, cadence, summary, and features', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByText('$8')).toBeInTheDocument()
  expect(screen.getAllByText('CAD / month')).toHaveLength(2)
  expect(screen.getByText('The essentials to get streaming.')).toBeInTheDocument()
  expect(screen.getByText('Access to all 1080p libraries')).toBeInTheDocument()
})

test('marks features as included or excluded', () => {
  render(<Pricing tiers={TIERS} />)
  const included = getFeatureRow({ label: 'Access to all 1080p libraries' })
  const excluded = getFeatureRow({ label: 'Access to all 4K libraries' })
  expect(within(included).getByText('Included:')).toBeInTheDocument()
  expect(within(excluded).getByText('Not included:')).toBeInTheDocument()
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
