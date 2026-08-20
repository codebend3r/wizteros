import { afterEach, expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillingToggle } from '@/components/BillingToggle/BillingToggle'
import { useBillingStore } from '@/stores/billingStore'

afterEach(() => {
  useBillingStore.setState({ cadence: 'monthly' })
})

test('offers both cadences as labelled radios in one named group', () => {
  render(<BillingToggle />)
  expect(screen.getByRole('group', { name: 'Billing cadence' })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'Annual 2 months free' })).not.toBeChecked()
})

test('states the saving on the annual option rather than hiding it in a default', () => {
  render(<BillingToggle />)
  expect(screen.getByText('2 months free')).toBeInTheDocument()
})

test('writes the chosen cadence to the store', async () => {
  render(<BillingToggle />)
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(useBillingStore.getState().cadence).toBe('annual')
  await userEvent.click(screen.getByRole('radio', { name: 'Monthly' }))
  expect(useBillingStore.getState().cadence).toBe('monthly')
})

test('swaps the cancellation wording with the cadence', async () => {
  render(<BillingToggle />)
  expect(
    screen.getByText('Charged every month. Cancel any time from the billing portal.'),
  ).toBeInTheDocument()
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(
    screen.getByText(
      'One charge covers the next twelve months. Cancel any time; access runs to the end of the year you paid for.',
    ),
  ).toBeInTheDocument()
})

test('reaches both options by keyboard alone', async () => {
  render(<BillingToggle />)
  await userEvent.tab()
  expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveFocus()
  await userEvent.keyboard('{ArrowRight}')
  expect(screen.getByRole('radio', { name: /Annual/ })).toBeChecked()
  expect(useBillingStore.getState().cadence).toBe('annual')
})
