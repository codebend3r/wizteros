import { afterEach, expect, test } from '@/test/vi'
import { render, screen, within } from '@testing-library/react'
import { StatusBoard } from '@/components/StatusBoard/StatusBoard'
import { toAnnualPricing } from '@/lib/billing'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'
import type { Tier } from '@/site.config'

const TIERS: ReadonlyArray<Tier> = [
  {
    id: 'silver',
    name: 'Silver',
    price: '$14',
    cadence: 'CAD / month',
    summary: 'Sharper picture, richer sound.',
    features: [{ label: '1080p HD streaming', included: true }],
    paymentLinkUrl: '',
    annual: toAnnualPricing({ price: '$14', paymentLinkUrl: '' }),
  },
  {
    id: 'gold',
    name: 'Gold',
    price: '$20',
    cadence: 'CAD / month',
    summary: 'Everything the server offers.',
    features: [{ label: '4K UHD streaming', included: true }],
    paymentLinkUrl: '',
    annual: toAnnualPricing({ price: '$20', paymentLinkUrl: '' }),
  },
]

afterEach(() => {
  useTierStore.setState({ selectedTierId: 'bronze' })
  useBillingStore.setState({ cadence: 'monthly' })
})

const getLedgerCard = (): HTMLElement => {
  const card = screen.getByRole('heading', { name: /a month goes/ }).closest('article')
  if (!card) throw new Error('No ledger card found')
  return card
}

test('ledgers the tier selected in the store', () => {
  useTierStore.setState({ selectedTierId: 'silver' })
  render(<StatusBoard tiers={TIERS} />)
  const card = getLedgerCard()
  expect(within(card).getByRole('heading', { name: 'Where $14 a month goes' })).toBeInTheDocument()
  expect(within(card).getByText('Silver')).toBeInTheDocument()
  expect(within(card).getByText('$5.20')).toBeInTheDocument()
  expect(within(card).getByText('$4.60')).toBeInTheDocument()
  expect(within(card).getByText('$2.40')).toBeInTheDocument()
  expect(within(card).getByText('$1.80')).toBeInTheDocument()
})

test('follows the store to another tier', () => {
  useTierStore.setState({ selectedTierId: 'gold' })
  render(<StatusBoard tiers={TIERS} />)
  const card = getLedgerCard()
  expect(within(card).getByRole('heading', { name: 'Where $20 a month goes' })).toBeInTheDocument()
  expect(within(card).getByText('Gold')).toBeInTheDocument()
  expect(within(card).getByText('$7.40')).toBeInTheDocument()
  expect(within(card).getByText('$6.60')).toBeInTheDocument()
  expect(within(card).getByText('$3.40')).toBeInTheDocument()
  expect(within(card).getByText('$2.60')).toBeInTheDocument()
})

test('falls back to the first tier when the selected id is absent', () => {
  useTierStore.setState({ selectedTierId: 'bronze' })
  render(<StatusBoard tiers={TIERS} />)
  expect(screen.getByRole('heading', { name: 'Where $14 a month goes' })).toBeInTheDocument()
})

test('splits the monthly equivalent, not the yearly total, under annual billing', () => {
  useTierStore.setState({ selectedTierId: 'silver' })
  useBillingStore.setState({ cadence: 'annual' })
  render(<StatusBoard tiers={TIERS} />)
  const card = getLedgerCard()
  // $14/month becomes $140 a year, which is $11.67 a month.
  expect(
    within(card).getByRole('heading', { name: 'Where $11.67 a month goes' }),
  ).toBeInTheDocument()
  const amounts = within(card)
    .getAllByText(/^\$\d/)
    .map((node) => Number(node.textContent?.replace('$', '')))
  expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(11.67, 2)
})
