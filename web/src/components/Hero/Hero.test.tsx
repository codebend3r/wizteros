import { render, screen } from '@testing-library/react'
import Hero from '@/components/Hero/Hero'

const props = {
  brandName: 'Westeroz',
  tagline: 'A community-run media server.',
  priceLabel: '$10 / month',
  paymentLinkUrl: 'https://buy.stripe.com/test_abc',
}

test('renders the brand, price, and a Contribute link to the payment url', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
  expect(screen.getByText('A community-run media server.')).toBeInTheDocument()
  expect(screen.getByText('$10 / month')).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: 'Contribute' })
  expect(cta).toHaveAttribute('href', 'https://buy.stripe.com/test_abc')
})
