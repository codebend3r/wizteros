import { render, screen } from '@testing-library/react'
import { expect, test } from '@/test/vi'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { useAuthStore } from '@/stores/authStore'

test('renders children directly while Supabase is unconfigured', () => {
  render(
    <AdminGate title="Test gate">
      <p>secret content</p>
    </AdminGate>,
  )
  expect(screen.getByText('secret content')).toBeInTheDocument()
})

test('shows the Supabase login instead of the children when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <AdminGate title="Test gate">
      <p>secret content</p>
    </AdminGate>,
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByText('secret content')).toBeNull()
})

test('renders children for an allowlisted signed-in session', () => {
  useAuthStore.setState({
    enabled: true,
    status: 'signed-in',
    email: 'cj.rivas.dev@gmail.com',
  })
  render(
    <AdminGate title="Test gate">
      <p>secret content</p>
    </AdminGate>,
  )
  expect(screen.getByText('secret content')).toBeInTheDocument()
})
