import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { LoginGate } from '@/components/LoginGate/LoginGate'
import { useAuthStore } from '@/stores/authStore'

const initialState = useAuthStore.getInitialState()

afterEach(() => {
  useAuthStore.setState(initialState, true)
})

test('renders children directly while Supabase is unconfigured', () => {
  render(
    <LoginGate title="Test gate">
      <p>secret content</p>
    </LoginGate>,
  )
  expect(screen.getByText('secret content')).toBeInTheDocument()
})

test('shows the sign-in form when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <LoginGate title="Test gate">
      <p>secret content</p>
    </LoginGate>,
  )
  expect(screen.queryByText('secret content')).toBeNull()
  expect(screen.getByLabelText('Email')).toBeInTheDocument()
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})

test('renders children for an allowlisted signed-in email', () => {
  useAuthStore.setState({
    enabled: true,
    status: 'signed-in',
    email: 'cj.rivas.dev@gmail.com',
  })
  render(
    <LoginGate title="Test gate">
      <p>secret content</p>
    </LoginGate>,
  )
  expect(screen.getByText('secret content')).toBeInTheDocument()
})

test('surfaces sign-in errors inline', async () => {
  useAuthStore.setState({
    enabled: true,
    status: 'signed-out',
    signIn: vi.fn(async () => {
      throw new Error('Invalid login credentials')
    }),
  })
  render(
    <LoginGate title="Test gate">
      <p>secret content</p>
    </LoginGate>,
  )

  await userEvent.type(screen.getByLabelText('Email'), 'cj.rivas.dev@gmail.com')
  await userEvent.type(screen.getByLabelText('Password'), 'wrong-password')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')
  expect(screen.queryByText('secret content')).toBeNull()
})

test('signs out a non-allowlisted email and keeps children hidden', async () => {
  const signOut = vi.fn(async () => {})
  useAuthStore.setState({
    enabled: true,
    status: 'signed-in',
    email: 'stranger@example.com',
    signOut,
  })
  render(
    <LoginGate title="Test gate">
      <p>secret content</p>
    </LoginGate>,
  )

  expect(screen.queryByText('secret content')).toBeNull()
  expect(await screen.findByRole('alert')).toHaveTextContent('This account is not allowed here')
  await waitFor(() => expect(signOut).toHaveBeenCalled())
})
