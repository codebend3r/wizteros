import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from '@/test/vi'
import { Email } from '@/pages/Email/Email'
import type { Member } from '@/lib/adminApi'

import * as adminApiOriginal from '@/lib/adminApi'

vi.mock('@/lib/adminApi', () => ({
  ...adminApiOriginal,
  fetchMembers: vi.fn(),
}))

const { fetchMembers } = await import('@/lib/adminApi')

const makeMember = (email: string): Member => ({
  member: email.split('@')[0] ?? email,
  email,
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: [],
  libraries: {},
  entitled: {},
  subscribed: false,
  invited_at: null,
  tag: null,
  customer_id: null,
})

const renderEmail = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Email />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
  vi.mocked(fetchMembers).mockResolvedValue([makeMember('a@x.com'), makeMember('b@x.com')])
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('renders a chip per member with the recipient count', async () => {
  renderEmail()
  expect(await screen.findByText('2 recipients')).toBeInTheDocument()
  expect(screen.getByText('a@x.com')).toBeInTheDocument()
  expect(screen.getByText('b@x.com')).toBeInTheDocument()
})

test('removing a chip drops the recipient and count; reset restores everyone', async () => {
  renderEmail()
  await screen.findByText('2 recipients')
  await userEvent.click(screen.getByRole('button', { name: 'Remove a@x.com' }))
  expect(screen.getByText('1 recipients')).toBeInTheDocument()
  expect(screen.queryByText('a@x.com')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(screen.getByText('2 recipients')).toBeInTheDocument()
  expect(screen.getByText('a@x.com')).toBeInTheDocument()
})

test('send is disabled only once no recipients remain', async () => {
  renderEmail()
  await screen.findByText('2 recipients')
  expect(screen.getByRole('button', { name: 'Send email' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Remove a@x.com' }))
  await userEvent.click(screen.getByRole('button', { name: 'Remove b@x.com' }))
  expect(screen.getByText('0 recipients')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled()
})
