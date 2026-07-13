import { render, screen } from '@testing-library/react'
import App from './App'
import { DEFAULT_PAYMENT_LINK_URL } from './site.config'

test('renders the brand heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
})

test('Contribute CTA points at the resolved payment link', () => {
  render(<App />)
  expect(screen.getByRole('link', { name: 'Contribute' })).toHaveAttribute(
    'href',
    DEFAULT_PAYMENT_LINK_URL,
  )
})

test('renders the three support items', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Server hardware' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Storage & bandwidth' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Maintenance & uptime' })).toBeInTheDocument()
})

test('hides the member link by default (no VITE_MEMBER_URL)', () => {
  render(<App />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})
