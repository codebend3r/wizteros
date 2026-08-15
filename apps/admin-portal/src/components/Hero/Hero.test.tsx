import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import { Hero } from '@/components/Hero/Hero'

const props = {
  brandName: 'Westeroz',
  tagline: 'Get access to the media servers.',
  memberUrl: null,
  fromPrice: '$8',
}

test('renders the headline, brand, and tagline with a link to pricing', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('heading', { name: "It's up. Come on in." })).toBeInTheDocument()
  expect(screen.getByText('Westeroz')).toBeInTheDocument()
  expect(screen.getByText('Get access to the media servers.')).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: 'Choose a plan' })
  expect(cta).toHaveAttribute('href', '#pricing')
})

test('anchors the section nav to the page sections', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '#status')
  expect(screen.getByRole('link', { name: 'Tiers' })).toHaveAttribute('href', '#pricing')
  expect(screen.getByRole('link', { name: 'Where it goes' })).toHaveAttribute(
    'href',
    '#where-it-goes',
  )
})

test('captions the CTA with the cheapest tier price', () => {
  render(<Hero {...props} />)
  expect(screen.getByText('From $8 CAD / month · Cancel any time')).toBeInTheDocument()
})

test('hides the sign-in link without a member url', () => {
  render(<Hero {...props} />)
  expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
})

test('links sign-in to the member url when provided', () => {
  render(<Hero {...props} memberUrl="https://app.plex.tv" />)
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    'https://app.plex.tv',
  )
})
