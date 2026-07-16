import { render, screen } from '@testing-library/react'
import Footer from '@/components/Footer/Footer'

test('shows the member link when a member url is provided', () => {
  render(<Footer memberUrl="https://invite.example.com" />)
  const link = screen.getByRole('link', { name: /access your account/i })
  expect(link).toHaveAttribute('href', 'https://invite.example.com')
})

test('hides the member link when member url is null', () => {
  render(<Footer memberUrl={null} />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})

test('hides the member link when member url is an empty string', () => {
  render(<Footer memberUrl="" />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})

test('always renders the framing disclaimer', () => {
  render(<Footer memberUrl={null} />)
  expect(screen.getByText(/not a purchase of content/i)).toBeInTheDocument()
})
