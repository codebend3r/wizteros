import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import Footer from '@/components/Footer/Footer'

test('shows the member link when a member url is provided', () => {
  render(<Footer memberUrl="https://invite.example.com" billingPortalUrl={null} />)
  const link = screen.getByRole('link', { name: /access your account/i })
  expect(link).toHaveAttribute('href', 'https://invite.example.com')
})

test('hides the member link when member url is null', () => {
  render(<Footer memberUrl={null} billingPortalUrl={null} />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})

test('hides the member link when member url is an empty string', () => {
  render(<Footer memberUrl="" billingPortalUrl={null} />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})

test('shows the manage link when a billing portal url is provided', () => {
  render(<Footer memberUrl={null} billingPortalUrl="https://billing.stripe.com/p/login/x" />)
  const link = screen.getByRole('link', { name: /manage or cancel/i })
  expect(link).toHaveAttribute('href', 'https://billing.stripe.com/p/login/x')
})

test('hides the manage link when billing portal url is null or empty', () => {
  render(<Footer memberUrl={null} billingPortalUrl={null} />)
  expect(screen.queryByRole('link', { name: /manage or cancel/i })).toBeNull()
  render(<Footer memberUrl={null} billingPortalUrl="" />)
  expect(screen.queryByRole('link', { name: /manage or cancel/i })).toBeNull()
})

test('always renders the framing disclaimer', () => {
  render(<Footer memberUrl={null} billingPortalUrl={null} />)
  expect(screen.getByText(/not a purchase of content/i)).toBeInTheDocument()
})
