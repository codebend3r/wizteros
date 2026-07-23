import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import Manage from '@/pages/Manage/Manage'
import { AdminAuthError, type Member } from '@/lib/adminApi'
import { useAuthStore } from '@/stores/authStore'

const member: Member = {
  member: 'cj',
  email: 'cj@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  subscribed: false,
  invited_at: null,
  tag: null,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMembers: vi.fn(),
  reissueInvite: vi.fn(),
}))

const { fetchMembers, reissueInvite } = await import('@/lib/adminApi')

const renderManage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Manage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
})

test('loads and renders members after the gate', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  renderManage()
  expect(await screen.findByText('cj')).toBeInTheDocument()
  expect(fetchMembers).toHaveBeenCalledWith()
})

test('shows a preloader while members are loading', () => {
  vi.mocked(fetchMembers).mockReturnValue(new Promise(() => {}))
  renderManage()
  expect(screen.getByRole('status')).toBeInTheDocument()
})

test('signs out of the Supabase session on an auth error during load', async () => {
  const signOut = vi.fn(async () => {})
  useAuthStore.setState({ signOut })
  vi.mocked(fetchMembers).mockRejectedValue(new AdminAuthError('nope'))
  renderManage()
  await waitFor(() => expect(signOut).toHaveBeenCalled())
})

test('filters members by email with the search input', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([
    member,
    { ...member, member: 'max', email: 'max@y.com' },
  ])
  renderManage()
  expect(await screen.findByText('cj')).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('Search by email'), 'max@')
  expect(screen.queryByText('cj')).toBeNull()
  expect(screen.getByText('max')).toBeInTheDocument()
})

test('inviting to a tier confirms via modal then updates the row optimistically', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([{ ...member, tier: 'unknown', downloads: null }])
  vi.mocked(reissueInvite).mockResolvedValue({
    url: 'https://x/j/abc',
    code: 'abc',
    tier: 'gold',
    disabled: 1,
    emailed: true,
  })
  renderManage()

  await userEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  await userEvent.click(screen.getByRole('menuitem', { name: /Gold Tier/ }))

  const dialog = screen.getByRole('dialog', { name: 'Confirm invite' })
  expect(dialog).toHaveTextContent('cj@x.com')
  expect(dialog).toHaveTextContent('Gold')

  await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).toHaveBeenCalledWith({
    email: 'cj@x.com',
    tier: 'gold',
  })
  // Access only starts at redemption, so the row reads Invited, not
  // Subscribed Monthly, until the member redeems the new link.
  expect(await screen.findByText('Invited')).toBeInTheDocument()
  expect(screen.queryByText('Subscribed Monthly')).not.toBeInTheDocument()
  expect(screen.getByText('gold')).toBeInTheDocument()
  expect(screen.getByText(/Invite emailed/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a failed invite email shows the manual-send fallback', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([{ ...member, tier: 'unknown', downloads: null }])
  vi.mocked(reissueInvite).mockResolvedValue({
    url: 'https://x/j/abc',
    code: 'abc',
    tier: 'gold',
    disabled: 1,
    emailed: false,
  })
  renderManage()

  await userEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  await userEvent.click(screen.getByRole('menuitem', { name: /Gold Tier/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Send invite' }))

  expect(await screen.findByText(/send this link manually/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
})

test('cancelling the confirm modal sends nothing', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  renderManage()

  await userEvent.click(await screen.findByRole('button', { name: 'Invite' }))
  await userEvent.click(screen.getByRole('menuitem', { name: /Bronze Tier/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  expect(reissueInvite).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('links to the invite page', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  renderManage()
  const link = await screen.findByRole('link', { name: '+ Invite someone' })
  expect(link).toHaveAttribute('href', '/invite')
})
