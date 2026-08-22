import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '@/App'

test('renders the marquee headline', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: "It's up. Come on in." })).toBeInTheDocument()
})

test('hero CTA scrolls to the pricing section', () => {
  render(<App />)
  expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '#pricing')
})

test('renders a tab per tier in the switcher', () => {
  render(<App />)
  expect(screen.getByRole('tab', { name: 'Bronze' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Silver' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Gold' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Youth' })).toBeInTheDocument()
})

test('ledger follows the tier chosen in the switcher', async () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Where $8 a month goes' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: 'Gold' }))
  expect(screen.getByRole('heading', { name: 'Where $20 a month goes' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: 'Silver' }))
  expect(screen.getByRole('heading', { name: 'Where $14 a month goes' })).toBeInTheDocument()
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
