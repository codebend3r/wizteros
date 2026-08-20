import { afterEach, expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnnualPreview } from '@/pages/AnnualPreview/AnnualPreview'
import { menuRoutes } from '@/components/SideMenu/SideMenu'
import { useAuthStore } from '@/stores/authStore'
import { useBillingStore } from '@/stores/billingStore'
import { useTierStore } from '@/stores/tierStore'

afterEach(() => {
  useTierStore.setState({ selectedTierId: 'silver' })
  useBillingStore.setState({ cadence: 'monthly' })
})

const renderPreview = () => {
  useAuthStore.setState({ enabled: false })
  return render(<AnnualPreview />)
}

test('stays out of the side menu so nothing links to it', () => {
  const menuPaths: ReadonlyArray<string> = menuRoutes.map(({ path }) => path)
  expect(menuPaths).not.toContain('/annual')
})

test('gates the preview behind the admin login when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(<AnnualPreview />)
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: /Annual/ })).toBeNull()
})

test('says plainly that the pricing is not live', () => {
  renderPreview()
  expect(screen.getByLabelText('Preview notice')).toHaveTextContent('Annual pricing is not live')
})

test('opens on monthly and renders the real pricing section', () => {
  renderPreview()
  expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked()
  expect(
    screen.getByRole('heading', { name: 'Four levels of server capability' }),
  ).toBeInTheDocument()
})

test('moves the whole page onto annual figures when toggled', async () => {
  renderPreview()
  await userEvent.click(screen.getByRole('tab', { name: 'Silver' }))
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  // Silver is $14 a month, so $140 a year and $11.67 a month.
  expect(screen.getByRole('heading', { name: 'Where $11.67 a month goes' })).toBeInTheDocument()
  expect(screen.getByText('One $140 CAD charge covers the next twelve months.')).toBeInTheDocument()
})

test('returns the cadence to monthly when the preview unmounts', async () => {
  const { unmount } = renderPreview()
  await userEvent.click(screen.getByRole('radio', { name: /Annual/ }))
  expect(useBillingStore.getState().cadence).toBe('annual')
  unmount()
  expect(useBillingStore.getState().cadence).toBe('monthly')
})

test('shows the rationale and the questions still open', () => {
  renderPreview()
  expect(screen.getByRole('heading', { name: 'Why it is shaped this way' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '2 months free, 16.7% off' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Still open' })).toBeInTheDocument()
})
