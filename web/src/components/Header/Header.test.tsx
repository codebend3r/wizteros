import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test } from 'vitest'
import Header from '@/components/Header/Header'

test('links the brand home and Members to /manage', () => {
  render(
    <MemoryRouter>
      <Header brandName="Westeroz" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Westeroz' })).toHaveAttribute('href', '/')
  expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/manage')
})

test('shows the mascot logo inside the brand link', () => {
  render(
    <MemoryRouter>
      <Header brandName="Westeroz" />
    </MemoryRouter>,
  )
  const brand = screen.getByRole('link', { name: 'Westeroz' })
  expect(brand.querySelector('img')).toBeInTheDocument()
})
