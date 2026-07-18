import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import User from '@/pages/User/User'
import type { Member, ResetExpiryResult } from '@/lib/adminApi'

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
  resetExpiry: vi.fn(),
  resetTier: vi.fn(),
}))

const {
  fetchMember,
  fetchMemberEvents,
  fetchMemberNotes,
  saveMemberNotes,
  reissueInvite,
  resetExpiry,
  resetTier,
} = await import('@/lib/adminApi')

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
  // 'Gold' appears on the Tier row and again on its hard-reset button.
  expect(screen.getAllByText('Gold')).toHaveLength(2)
  expect(screen.getAllByRole('img', { name: 'gold tier' })).toHaveLength(2)
  expect(screen.getByText('✅')).toBeInTheDocument()
  expect(
    screen.getByText(new Date('2099-09-01T00:00:00+00:00').toLocaleString()),
  ).toBeInTheDocument()
  expect(screen.getByText(/\(\d+ days left\)/)).toBeInTheDocument()
})

test('shows each server with its libraries as pills, with counts', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })

  expect(await screen.findByText('Meleys')).toBeInTheDocument()
  expect(screen.getByText('01. Movies')).toBeInTheDocument()
  expect(screen.getByText('03. 4K TV Shows')).toBeInTheDocument()
  expect(screen.getByText('Vermithor')).toBeInTheDocument()
  expect(screen.getByText('01. TV Shows')).toBeInTheDocument()
  expect(screen.getByText('2 servers · 3 libraries')).toBeInTheDocument()
  expect(screen.getByText('2 libraries')).toBeInTheDocument()
  expect(screen.getByText('1 library')).toBeInTheDocument()
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

test('hard resets the tier in place and reflects it in the details', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMember).mockResolvedValue(member)
  vi.mocked(resetTier).mockResolvedValue({ email: 'max@y.com', tier: 'silver' })
  renderUser({ email: 'max@y.com' })

  await screen.findByRole('heading', { name: 'max' })
  // one silver icon before (its hard-reset button); details still show gold
  expect(screen.getAllByRole('img', { name: 'silver tier' })).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'silver tier Silver' }))

  expect(resetTier).toHaveBeenCalledWith({
    email: 'max@y.com',
    tier: 'silver',
    password: 'secret',
  })
  // details tier flips to silver without any invite flow
  await waitFor(() => expect(screen.getAllByRole('img', { name: 'silver tier' })).toHaveLength(2))
  expect(reissueInvite).not.toHaveBeenCalled()
})

test('seeds the expiry picker with one minute after midnight', async () => {
  vi.mocked(fetchMember).mockResolvedValue(member)
  renderUser({ email: 'max@y.com' })
  await screen.findByRole('heading', { name: 'max' })
  expect(screen.getByLabelText('New expiry date and time')).toHaveDisplayValue(/T00:01$/)
})

test('sets the expiry optimistically with a spinner while in flight', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMember).mockResolvedValue(member)
  let settle: (value: ResetExpiryResult) => void = () => undefined
  vi.mocked(resetExpiry).mockImplementation(
    () =>
      new Promise<ResetExpiryResult>((resolve) => {
        settle = resolve
      }),
  )
  renderUser({ email: 'max@y.com' })

  await screen.findByRole('heading', { name: 'max' })
  const picked = '2099-12-25T00:01'
  fireEvent.change(screen.getByLabelText('New expiry date and time'), {
    target: { value: picked },
  })
  await user.click(screen.getByRole('button', { name: 'Set expiry' }))

  const pickedIso = new Date(picked).toISOString()
  expect(resetExpiry).toHaveBeenCalledWith({
    email: 'max@y.com',
    expiresAt: pickedIso,
    password: 'secret',
  })
  // optimistic: the details row shows the new expiry before the bridge replies
  expect(screen.getByText(new Date(pickedIso).toLocaleString())).toBeInTheDocument()
  expect(screen.getByRole('status', { name: 'Updating expiry' })).toBeInTheDocument()

  settle({ updated: 1, expires: pickedIso })
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: 'Updating expiry' })).not.toBeInTheDocument(),
  )
  expect(screen.getByText(new Date(pickedIso).toLocaleString())).toBeInTheDocument()
})

test('rolls the expiry back when the bridge rejects it', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMember).mockResolvedValue(member)
  vi.mocked(resetExpiry).mockRejectedValue(new Error('boom'))
  renderUser({ email: 'max@y.com' })

  await screen.findByRole('heading', { name: 'max' })
  const original = new Date(member.expires ?? '').toLocaleString()
  fireEvent.change(screen.getByLabelText('New expiry date and time'), {
    target: { value: '2099-12-25T00:01' },
  })
  await user.click(screen.getByRole('button', { name: 'Set expiry' }))

  expect(await screen.findByText('Could not set expiry.')).toBeInTheDocument()
  expect(screen.getByText(original)).toBeInTheDocument()
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
