import { afterEach, expect, test } from '@/test/vi'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pricing } from '@/components/Pricing/Pricing'
import { toAnnualPricing } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'
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
    annual: toAnnualPricing({
      price: '$8',
      paymentLinkUrl: 'https://buy.stripe.com/test_bronze_annual',
    }),
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$20',
    cadence: 'CAD / month',
    summary: 'Everything the server offers.',
    features: [{ label: 'Offline downloads for travel', included: true }],
    paymentLinkUrl: '',
    annual: toAnnualPricing({ price: '$20', paymentLinkUrl: '' }),
  },
]

afterEach(() => {
  useTierStore.setState({ selectedTierId: 'bronze' })
  useBillingStore.setState({ cadence: 'monthly' })
})

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

test('renders a tab per tier and opens on the store default', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('tab', { name: 'Bronze' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: 'Gold' })).toHaveAttribute('aria-selected', 'false')
})

test('falls back to the first tier when the selected one is not offered', () => {
  useTierStore.setState({ selectedTierId: 'silver' })
  render(<Pricing tiers={TIERS} />)
  expect(screen.getByRole('tab', { name: 'Bronze' })).toHaveAttribute('aria-selected', 'true')
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

test('draws an inert button on the preview when no payment link backs the cadence', async () => {
  render(<Pricing tiers={TIERS} preview />)
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  await userEvent.click(screen.getByRole('tab', { name: 'Gold' }))
  const inert = screen.getByRole('button', { name: 'Choose Gold, billed annually' })
  expect(inert).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByText('No payment link configured, so this does nothing.')).toBeInTheDocument()
})

test('leaves the hole on the live page rather than drawing a button that goes nowhere', async () => {
  render(<Pricing tiers={TIERS} />)
  await userEvent.click(screen.getByRole('tab', { name: 'Gold' }))
  expect(screen.queryByRole('button', { name: /Choose Gold/ })).toBeNull()
})

test('hides the cadence toggle unless the surface asks for it', () => {
  render(<Pricing tiers={TIERS} />)
  expect(screen.queryByRole('radio', { name: /Annual/ })).toBeNull()
})

test('renders the cadence toggle when enabled, with monthly selected', () => {
  render(<Pricing tiers={TIERS} preview />)
  expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked()
  expect(screen.getByRole('radio', { name: /Annual/ })).not.toBeChecked()
})

test('switching to annual quotes the monthly equivalent and keeps the year total on screen', async () => {
  render(<Pricing tiers={TIERS} preview />)
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  const panel = screen.getByRole('tabpanel')
  // $8 a month becomes $80 a year, which is $6.67 a month.
  expect(within(panel).getByText('$6.67')).toBeInTheDocument()
  expect(within(panel).getByText('CAD / month, billed annually')).toBeInTheDocument()
  expect(within(panel).getByText('$8 / month')).toBeInTheDocument()
  expect(within(panel).getByText('Save $16 a year')).toBeInTheDocument()
  expect(
    within(panel).getByText('One $80 CAD charge covers the next twelve months.'),
  ).toBeInTheDocument()
})

test('sends the annual CTA to the annual payment link', async () => {
  render(<Pricing tiers={TIERS} preview />)
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(screen.getByRole('link', { name: 'Choose Bronze, billed annually' })).toHaveAttribute(
    'href',
    'https://buy.stripe.com/test_bronze_annual',
  )
})

test('quotes the upgrade hint in the cadence on screen', async () => {
  render(<Pricing tiers={TIERS} preview />)
  expect(
    within(getFeatureRow({ label: 'Offline downloads for travel' })).getByText('in Gold, +$12'),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(
    within(getFeatureRow({ label: 'Offline downloads for travel' })).getByText(
      'in Gold, +$120 a year',
    ),
  ).toBeInTheDocument()
})

test('moves the cancellation promise to the paid year under annual billing', async () => {
  render(<Pricing tiers={TIERS} preview />)
  expect(
    screen.getByText('Cancel from the billing portal, access ends at cycle end'),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(
    screen.getByText('Cancel from the billing portal, access runs to the end of the paid year'),
  ).toBeInTheDocument()
})
