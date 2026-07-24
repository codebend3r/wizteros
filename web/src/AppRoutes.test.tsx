import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from '@/test/vi'
import AppRoutes from '@/AppRoutes'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => {
  // Unmount before resetting the store, so flipping `enabled` back to false
  // can't re-render a still-mounted /manage into its (QueryClient-less) body.
  cleanup()
  sessionStorage.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

test('renders the landing page at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Choose your tier' })).toBeInTheDocument()
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
