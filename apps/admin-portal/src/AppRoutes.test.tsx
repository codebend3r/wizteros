import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from '@/test/vi'
import { AppRoutes } from '@/AppRoutes'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => {
  sessionStorage.clear()
})

test('renders the landing page at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(
    screen.getByRole('heading', { name: 'Four levels of server capability' }),
  ).toBeInTheDocument()
})

test('gates /manage behind the Supabase login when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})

test('serves the single login page at /login', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Admin login' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})
