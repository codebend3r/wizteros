import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Manage from '@/pages/Manage/Manage'
import { AdminAuthError, type Member } from '@/lib/adminApi'

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
  fetchMembers: vi.fn(),
}))

const { fetchMembers } = await import('@/lib/adminApi')

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('loads and renders members after the gate', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  render(<Manage />)
  expect(await screen.findByText('cj')).toBeInTheDocument()
  expect(fetchMembers).toHaveBeenCalledWith({ password: 'secret' })
})

test('returns to the password gate on an auth error during load', async () => {
  vi.mocked(fetchMembers).mockRejectedValue(new AdminAuthError('nope'))
  render(<Manage />)
  expect(await screen.findByLabelText('Password')).toBeInTheDocument()
})
