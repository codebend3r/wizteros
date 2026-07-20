import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Invite from '@/pages/Invite/Invite'

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMembers: vi.fn(),
  reissueInvite: vi.fn(),
}))

const { fetchMembers } = await import('@/lib/adminApi')

const renderInvite = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Invite />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
  vi.mocked(fetchMembers).mockResolvedValue([])
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('requires the admin password gate', () => {
  sessionStorage.clear()
  renderInvite()
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
})

test('shows the invite heading and back link after the gate', () => {
  renderInvite()
  expect(screen.getByRole('heading', { name: 'Invite someone' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '← All members' })).toHaveAttribute('href', '/manage')
})
