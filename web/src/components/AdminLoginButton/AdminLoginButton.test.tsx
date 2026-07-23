import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'vitest'
import { AdminLoginButton } from '@/components/AdminLoginButton/AdminLoginButton'
import { useAuthStore } from '@/stores/authStore'

const initialState = useAuthStore.getInitialState()

afterEach(() => {
  useAuthStore.setState(initialState, true)
})

test('renders nothing while Supabase is unconfigured', () => {
  const { container } = render(
    <MemoryRouter>
      <AdminLoginButton />
    </MemoryRouter>,
  )
  expect(container).toBeEmptyDOMElement()
})

test('links to the login page when Supabase is configured', () => {
  useAuthStore.setState({ enabled: true })
  render(
    <MemoryRouter>
      <AdminLoginButton />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Admin login' })).toHaveAttribute('href', '/login')
})
