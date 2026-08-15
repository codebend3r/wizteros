import { expect, test } from '@/test/vi'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pricing } from '@/components/Pricing/Pricing'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'bronze',
    name: 'Bronze',
    price: '$8',
    cadence: 'CAD / month',
    summary: 'Everyday playback in 1080p.',
    features: [
      { label: '1080p HD streaming', included: true },
      { label: '4K UHD streaming', included: false },
      { label: 'Offline downloads for travel', included: false },
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
  expect(
    screen.getByRole('heading', { name: 'Four levels of server capability' }),
  ).toBeInTheDocument()
})

test('renders a tab per tier and selects the first without a silver tier', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('tab', { name: 'Bronze' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: 'Gold' })).toHaveAttribute('aria-selected', 'false')
})

test('shows the selected tier card with price, cadence, summary, and features', () => {
  render(<Pricing tiers={TIERS} />)
  const panel = screen.getByRole('tabpanel')
  expect(within(panel).getByText('$8')).toBeInTheDocument()
  expect(within(panel).getByText('CAD / month')).toBeInTheDocument()
  expect(within(panel).getByText('Everyday playback in 1080p.')).toBeInTheDocument()
  expect(within(panel).getByText('1080p HD streaming')).toBeInTheDocument()
})

test('switches the card when another tab is chosen', async () => {
  render(<Pricing tiers={TIERS} />)
  await userEvent.click(screen.getByRole('tab', { name: 'Gold' }))
  const panel = screen.getByRole('tabpanel')
  expect(within(panel).getByText('$20')).toBeInTheDocument()
  expect(within(panel).queryByText('$8')).toBeNull()
})

test('marks features as included or excluded', () => {
  render(<Pricing tiers={TIERS} />)
  const included = getFeatureRow({ label: '1080p HD streaming' })
  const excluded = getFeatureRow({ label: '4K UHD streaming' })
  expect(within(included).getByText('Included:')).toBeInTheDocument()
  expect(within(excluded).getByText('Not included:')).toBeInTheDocument()
})

test('hints the cheapest upgrade that includes an excluded feature', () => {
  render(<Pricing tiers={TIERS} />)
  const downloads = getFeatureRow({ label: 'Offline downloads for travel' })
  expect(within(downloads).getByText('in Gold, +$12')).toBeInTheDocument()
  const uhd = getFeatureRow({ label: '4K UHD streaming' })
  expect(within(uhd).queryByText(/^in /)).toBeNull()
})

test('links the CTA to the tier payment link', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('link', { name: 'Choose Bronze' })).toHaveAttribute(
    'href',
    'https://buy.stripe.com/test_bronze',
  )
})

test('hides the CTA when the payment link is not configured', async () => {
  render(<Pricing tiers={TIERS} />)
  await userEvent.click(screen.getByRole('tab', { name: 'Gold' }))
  expect(screen.queryByRole('link', { name: 'Choose Gold' })).toBeNull()
})
