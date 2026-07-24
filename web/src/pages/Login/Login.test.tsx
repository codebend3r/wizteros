import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, expect, test } from '@/test/vi'
import Login from '@/pages/Login/Login'
import { useAuthStore } from '@/stores/authStore'

const initialState = useAuthStore.getInitialState()

afterEach(() => {
  useAuthStore.setState(initialState, true)
})

const renderAt = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/manage" element={<p>manage page</p>} />
      </Routes>
    </MemoryRouter>,
  )

test('shows the login form when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  renderAt('/login')
  expect(screen.getByRole('heading', { name: 'Admin login' })).toBeInTheDocument()
  expect(screen.queryByText('manage page')).toBeNull()
})

test('redirects an allowlisted signed-in session to the admin area', () => {
  useAuthStore.setState({
    enabled: true,
    status: 'signed-in',
    email: 'cj.rivas.dev@gmail.com',
  })
  renderAt('/login')
  expect(screen.getByText('manage page')).toBeInTheDocument()
})
