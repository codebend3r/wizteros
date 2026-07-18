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
