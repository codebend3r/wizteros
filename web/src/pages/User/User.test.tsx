import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import User from '@/pages/User/User'
import type { Member } from '@/lib/adminApi'

const member: Member = {
  member: 'max',
  email: 'max@y.com',
  tier: 'gold',
  downloads: true,
  expires: '2099-09-01T00:00:00+00:00',
  servers: ['Meleys', 'Vermithor'],
  subscribed: true,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMember: vi.fn(),
}))

const { fetchMember } = await import('@/lib/adminApi')

const renderUser = ({ email }: { email: string | null }) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const search = email === null ? '' : `?email=${encodeURIComponent(email)}`
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/user${search}`]}>
        <User />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('loads the member from the email query param and shows every detail', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })

  expect(await screen.findByRole('heading', { name: 'max' })).toBeInTheDocument()
  expect(fetchMember).toHaveBeenCalledWith({ email: 'max@y.com', password: 'secret' })
  expect(screen.getByText('max@y.com')).toBeInTheDocument()
  expect(screen.getByText('Subscribed Monthly')).toBeInTheDocument()
  expect(screen.getByText('Gold')).toBeInTheDocument()
  expect(screen.getAllByRole('img', { name: 'gold tier' })).toHaveLength(2)
  expect(screen.getByText('Included')).toBeInTheDocument()
  expect(
    screen.getByText(new Date('2099-09-01T00:00:00+00:00').toLocaleDateString()),
  ).toBeInTheDocument()
  expect(screen.getByText('Meleys, Vermithor')).toBeInTheDocument()
})

test('shows a not-found notice when no member matches the email', async () => {
  vi.mocked(fetchMember).mockResolvedValue(null)
  renderUser({ email: 'ghost@y.com' })
  expect(await screen.findByText('No member found for ghost@y.com.')).toBeInTheDocument()
})

test('asks for an email when the query param is missing', () => {
  renderUser({ email: null })
  expect(screen.getByText('No email provided.')).toBeInTheDocument()
  expect(fetchMember).not.toHaveBeenCalled()
})

test('links back to the members table', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })
  expect(await screen.findByRole('link', { name: '← All members' })).toHaveAttribute(
    'href',
    '/manage',
  )
})
