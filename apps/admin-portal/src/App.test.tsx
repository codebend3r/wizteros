import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import { App } from '@/App'

test('renders the brand heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
})

test('hero CTA scrolls to the pricing section', () => {
  render(<App />)
  expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '#pricing')
})

test('renders the four tier cards', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Silver' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Gold' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Youth' })).toBeInTheDocument()
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
