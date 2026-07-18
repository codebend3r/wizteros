import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
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
  libraries: {
    Meleys: ['01. Movies', '03. 4K TV Shows'],
    Vermithor: ['01. TV Shows'],
  },
  subscribed: true,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMember: vi.fn(),
  fetchMemberEvents: vi.fn(),
  fetchMemberNotes: vi.fn(),
  saveMemberNotes: vi.fn(),
  reissueInvite: vi.fn(),
}))

const { fetchMember, fetchMemberEvents, fetchMemberNotes, saveMemberNotes, reissueInvite } =
  await import('@/lib/adminApi')

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
  vi.mocked(fetchMemberNotes).mockResolvedValue({ email: 'max@y.com', notes: '' })
  vi.mocked(fetchMemberEvents).mockResolvedValue([])
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
  expect(screen.getByText('🟢')).toBeInTheDocument()
  expect(screen.getByText('Gold')).toBeInTheDocument()
  // Status now carries the emoji, so the tier icon only appears on the Tier row.
  expect(screen.getAllByRole('img', { name: 'gold tier' })).toHaveLength(1)
  expect(screen.getByText('✅')).toBeInTheDocument()
  expect(
    screen.getByText(new Date('2099-09-01T00:00:00+00:00').toLocaleDateString()),
  ).toBeInTheDocument()
  expect(screen.getByText(/\(\d+ days left\)/)).toBeInTheDocument()
})

test('shows each server with the libraries its tier grants underneath', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })

  expect(await screen.findByText('Meleys')).toBeInTheDocument()
  expect(screen.getByText('01. Movies, 03. 4K TV Shows')).toBeInTheDocument()
  expect(screen.getByText('Vermithor')).toBeInTheDocument()
  expect(screen.getByText('01. TV Shows')).toBeInTheDocument()
})

test('shows ❌ downloads and no days-left bracket for a lapsed member', async () => {
  vi.mocked(fetchMember).mockResolvedValue({
    ...member,
    downloads: false,
    expires: null,
    subscribed: false,
  })
  renderUser({ email: 'max@y.com' })

  expect(await screen.findByText('❌')).toBeInTheDocument()
  expect(screen.queryByText(/days left/)).not.toBeInTheDocument()
})

test('re-invites through the tier menu and confirm modal', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMember).mockResolvedValue(member)
  vi.mocked(reissueInvite).mockResolvedValue({
    url: 'http://inv/j/xyz',
    code: 'xyz',
    tier: 'gold',
    disabled: 2,
    emailed: true,
  })
  renderUser({ email: 'max@y.com' })

  await user.click(await screen.findByRole('button', { name: 'Re-invite' }))
  await user.click(screen.getByRole('menuitem', { name: /Gold Tier/ }))
  expect(screen.getByRole('dialog', { name: 'Confirm invite' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).toHaveBeenCalledWith({
    email: 'max@y.com',
    tier: 'gold',
    password: 'secret',
  })
  expect(await screen.findByText('http://inv/j/xyz')).toBeInTheDocument()
  expect(screen.getByText(/Invite emailed/)).toBeInTheDocument()
})

test('offers a mailto send-email button for the member', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })
  expect(await screen.findByRole('link', { name: 'Send email' })).toHaveAttribute(
    'href',
    'mailto:max@y.com',
  )
})

test('loads saved notes and saves an edited draft', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMember).mockResolvedValue(member)
  vi.mocked(fetchMemberNotes).mockResolvedValue({ email: 'max@y.com', notes: 'met at work' })
  vi.mocked(saveMemberNotes).mockResolvedValue({ email: 'max@y.com', notes: 'met at work, kind' })
  renderUser({ email: 'max@y.com' })

  const textarea = await screen.findByRole('textbox', { name: 'Member notes' })
  expect(textarea).toHaveValue('met at work')
  const save = screen.getByRole('button', { name: 'Save notes' })
  expect(save).toBeDisabled()

  await user.type(textarea, ', kind')
  expect(save).toBeEnabled()
  await user.click(save)

  expect(saveMemberNotes).toHaveBeenCalledWith({
    email: 'max@y.com',
    notes: 'met at work, kind',
    password: 'secret',
  })
  expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
})

test('shows the member action history newest first', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  vi.mocked(fetchMemberEvents).mockResolvedValue([
    {
      id: 2,
      at: '2026-07-01T10:00:00+00:00',
      email: 'max@y.com',
      action: 'Invite issued',
      detail: 'gold tier — link emailed',
    },
    {
      id: 1,
      at: '2026-06-01T09:00:00+00:00',
      email: 'max@y.com',
      action: 'Signed up',
      detail: 'silver tier — invite emailed',
    },
  ])
  renderUser({ email: 'max@y.com' })

  expect(await screen.findByText('Invite issued')).toBeInTheDocument()
  expect(screen.getByText('gold tier — link emailed')).toBeInTheDocument()
  expect(screen.getByText('Signed up')).toBeInTheDocument()
  expect(screen.getByText('silver tier — invite emailed')).toBeInTheDocument()
})

test('derives a Membership expired row when the expiry has passed', async () => {
  vi.mocked(fetchMember).mockResolvedValue({ ...member, expires: '2020-01-01T00:00:00+00:00' })
  renderUser({ email: 'max@y.com' })
  expect(await screen.findByText('Membership expired')).toBeInTheDocument()
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

test('wraps the page in the full-width header and footer', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })
  expect(await screen.findByRole('banner')).toBeInTheDocument()
  expect(screen.getByRole('contentinfo')).toBeInTheDocument()
})

test('links back to the members table', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })
  expect(await screen.findByRole('link', { name: '← All members' })).toHaveAttribute(
    'href',
    '/manage',
  )
})
