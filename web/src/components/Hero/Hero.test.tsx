import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import Hero from '@/components/Hero/Hero'

const props = {
  brandName: 'Westeroz',
  tagline: 'A community-run media server.',
}

test('renders the brand and tagline with a link to pricing', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
  expect(screen.getByText('A community-run media server.')).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: 'Choose a plan' })
  expect(cta).toHaveAttribute('href', '#pricing')
})
