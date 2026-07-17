import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ResetUser from '@/pages/ResetUser/ResetUser'
import type { Member } from '@/lib/adminApi'

const member: Member = {
  member: 'cj',
  email: 'cj@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Meleys'],
  subscribed: false,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMember: vi.fn(),
  resetExpiry: vi.fn(),
  reissueInvite: vi.fn(),
}))

const api = await import('@/lib/adminApi')

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('disables Find until the input is a valid email', async () => {
  render(<ResetUser />)
  const find = screen.getByRole('button', { name: 'Find' })
  expect(find).toBeDisabled()
  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  expect(find).toBeEnabled()
})

test('looks up a member and applies an expiry preset', async () => {
  vi.mocked(api.fetchMember).mockResolvedValue(member)
  vi.mocked(api.resetExpiry).mockResolvedValue({ updated: 1, expires: null })
  render(<ResetUser />)

  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  await userEvent.click(screen.getByRole('button', { name: 'Find' }))

  await userEvent.click(await screen.findByRole('button', { name: '35 days' }))
  expect(api.resetExpiry).toHaveBeenCalledWith({ email: 'cj@x.com', days: 35, password: 'secret' })
})

test('applies a tier preset via reissue-invite', async () => {
  vi.mocked(api.fetchMember).mockResolvedValue(member)
  vi.mocked(api.reissueInvite).mockResolvedValue({
    url: 'http://inv/j/x',
    code: 'x',
    tier: 'silver',
    disabled: 1,
  })
  render(<ResetUser />)

  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  await userEvent.click(screen.getByRole('button', { name: 'Find' }))
  await userEvent.click(await screen.findByRole('button', { name: 'silver' }))
  expect(api.reissueInvite).toHaveBeenCalledWith({
    email: 'cj@x.com',
    tier: 'silver',
    password: 'secret',
  })
})
