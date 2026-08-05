import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from '@/test/vi'
import { Invite } from '@/pages/Invite/Invite'
import { AdminAuthError, type InviteResult, type Member } from '@/lib/adminApi'
import { useAuthStore } from '@/stores/authStore'

import * as adminApiOriginal from '@/lib/adminApi'

vi.mock('@/lib/adminApi', () => ({
  ...adminApiOriginal,
  fetchMembers: vi.fn(),
  reissueInvite: vi.fn(),
}))

const { fetchMembers, reissueInvite } = await import('@/lib/adminApi')

const renderInvite = (
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) => ({
  queryClient,
  ...render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Invite />
      </MemoryRouter>
    </QueryClientProvider>,
  ),
})

beforeEach(() => {
  vi.mocked(fetchMembers).mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('requires the Supabase login gate when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  renderInvite()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByLabelText('Email address')).toBeNull()
})

test('shows the invite heading and back link after the gate', () => {
  renderInvite()
  expect(screen.getByRole('heading', { name: 'Invite someone' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '← All members' })).toHaveAttribute('href', '/manage')
})

const gold: InviteResult = {
  url: 'https://x/j/abc',
  code: 'abc',
  tier: 'gold',
  disabled: 0,
  emailed: true,
}

test('send stays disabled until a valid email and a tier are chosen', async () => {
  renderInvite()
  const send = await screen.findByRole('button', { name: 'Send invite' })
  expect(send).toBeDisabled()
  await userEvent.type(screen.getByLabelText('Email address'), 'not-an-email')
  await userEvent.click(screen.getByRole('radio', { name: /Gold/ }))
  expect(send).toBeDisabled()
  await userEvent.clear(screen.getByLabelText('Email address'))
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  expect(send).toBeEnabled()
})

test('sends an invite for the typed email and selected tier, then clears the form', async () => {
  vi.mocked(reissueInvite).mockResolvedValue(gold)
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Gold/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

  const dialog = screen.getByRole('dialog', { name: 'Confirm invite' })
  expect(dialog).toHaveTextContent('new@x.com')
  expect(dialog).toHaveTextContent('Gold')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).toHaveBeenCalledWith({
    email: 'new@x.com',
    tier: 'gold',
  })
  expect(await screen.findByText(/Invite emailed/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'View member' })).toHaveAttribute(
    'href',
    '/user?email=new%40x.com',
  )
  expect(screen.getByLabelText('Email address')).toHaveValue('')
  expect(screen.getByRole('radio', { name: /Gold/ })).not.toBeChecked()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('clears the previous result notice when the email changes', async () => {
  vi.mocked(reissueInvite).mockResolvedValue(gold)
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Gold/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  expect(await screen.findByText(/Invite emailed/)).toBeInTheDocument()

  await userEvent.type(screen.getByLabelText('Email address'), 'n')
  expect(screen.queryByText(/Invite emailed/)).toBeNull()
})

test('primes the members cache with a pending row after a successful send', async () => {
  vi.mocked(reissueInvite).mockResolvedValue(gold)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['members'], [])
  renderInvite(queryClient)
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Gold/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  expect(await screen.findByText(/Invite emailed/)).toBeInTheDocument()

  expect(queryClient.getQueryData<Member[]>(['members'])).toContainEqual(
    expect.objectContaining({
      email: 'new@x.com',
      tier: 'gold',
      subscribed: false,
      invited_at: expect.any(String),
      tag: null,
      expires: null,
    }),
  )
})

test('a failed invite email shows the manual-send link', async () => {
  vi.mocked(reissueInvite).mockResolvedValue({ ...gold, emailed: false })
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Silver/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  expect(await screen.findByText(/send this link manually/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
})

test('signs out of the Supabase session on an auth error during send', async () => {
  const signOut = vi.fn(async () => {})
  useAuthStore.setState({ signOut })
  vi.mocked(reissueInvite).mockRejectedValue(new AdminAuthError('nope'))
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Bronze/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  await waitFor(() => expect(signOut).toHaveBeenCalled())
})

const existing: Member = {
  member: 'cody',
  email: 'new@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Vermithor'],
  libraries: {},
  entitled: {},
  subscribed: false,
  invited_at: null,
  tag: null,
  customer_id: null,
}

test('blocks an email that already belongs to a member', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([existing])
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('radio', { name: /Gold/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).not.toHaveBeenCalled()
  expect(screen.getByText(/already a member/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Go to member' })).toHaveAttribute(
    'href',
    '/user?email=new%40x.com',
  )
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('send waits while the members list is still loading', () => {
  vi.mocked(fetchMembers).mockReturnValue(new Promise(() => {}))
  renderInvite()
  expect(screen.getByRole('button', { name: 'Checking members…' })).toBeDisabled()
})
