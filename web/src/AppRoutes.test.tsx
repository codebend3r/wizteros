import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'vitest'
import AppRoutes from '@/AppRoutes'

afterEach(() => {
  sessionStorage.clear()
})

test('renders the landing page at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Choose your tier' })).toBeInTheDocument()
})

test('renders the admin gate at /manage', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
})
