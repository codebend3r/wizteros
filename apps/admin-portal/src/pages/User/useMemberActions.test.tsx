import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from '@/test/vi'
import { createQueryClient } from '@/lib/queryClient'
import { memberKeys, MEMBERS_QUERY_KEY } from '@/lib/memberQueries'
import * as apiOriginal from '@/lib/adminApi'
import type { Member } from '@/lib/adminApi'
import { useMemberActions } from './useMemberActions'

vi.mock('@/lib/adminApi', () => ({
  ...apiOriginal,
  fetchMember: vi.fn(),
  resetExpiry: vi.fn(),
  resetTier: vi.fn(),
  reissueInvite: vi.fn(),
}))
const api = await import('@/lib/adminApi')

const member: Member = {
  member: 'max',
  email: 'max@y.com',
  tier: 'gold',
  downloads: false,
  expires: '2099-09-01T00:00:00+00:00',
  servers: ['Meleys'],
  libraries: {},
  entitled: {},
  subscribed: true,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: 'cus_1',
  stripe_email: null,
}

const setup = (initial = member) => {
  const client = createQueryClient()
  client.setQueryData(memberKeys.member(initial.email), initial)
  client.setQueryData(MEMBERS_QUERY_KEY, [initial])
  vi.mocked(api.fetchMember).mockResolvedValue(initial)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () => {
      const query = useQuery({
        queryKey: memberKeys.member(initial.email),
        queryFn: () => api.fetchMember({ email: initial.email }),
        staleTime: Infinity,
      })
      return { actions: useMemberActions({ email: initial.email }), member: query.data }
    },
    { wrapper },
  )
  return { ...hook, client }
}

beforeEach(() => {
  vi.mocked(api.resetExpiry).mockResolvedValue({ updated: 1, expires: null })
})
afterEach(() => vi.restoreAllMocks())

test('expiry changes never manufacture subscription state', async () => {
  const initial = { ...member, subscribed: false }
  const { result } = setup(initial)
  const expiresAt = '2099-12-25T00:01:00.000Z'
  vi.mocked(api.resetExpiry).mockResolvedValue({ updated: 1, expires: expiresAt })
  vi.mocked(api.fetchMember).mockResolvedValue({ ...initial, expires: expiresAt })
  act(() => result.current.actions.expiry.mutate(expiresAt))
  await waitFor(() => expect(result.current.actions.expiry.isSuccess).toBe(true))
  expect(result.current.member?.subscribed ?? null).toBe(false)
  expect(api.fetchMember).toHaveBeenCalled()
})

test('clearing expiry does not cancel a subscription', async () => {
  const { result } = setup()
  vi.mocked(api.fetchMember).mockResolvedValue({ ...member, expires: null })
  act(() => result.current.actions.neverExpire.mutate())
  await waitFor(() => expect(result.current.actions.neverExpire.isSuccess).toBe(true))
  expect(result.current.member?.subscribed ?? null).toBe(true)
  expect(api.fetchMember).toHaveBeenCalled()
})

test('reissued invites reconcile downloads and entitlements instead of guessing tier defaults', async () => {
  const { result } = setup()
  const canonical: Member = {
    ...member,
    tier: 'youth',
    entitled: { Meleys: ['03. Family Movies'] },
    invited_at: '2026-10-24T00:00:00+00:00',
  }
  vi.mocked(api.reissueInvite).mockResolvedValue({
    tier: 'youth',
    url: 'https://invite/j/abc',
    code: 'abc',
    disabled: 0,
    emailed: true,
  })
  vi.mocked(api.fetchMember).mockResolvedValue(canonical)
  act(() => result.current.actions.invite.mutate('youth'))
  await waitFor(() => expect(result.current.member?.entitled ?? {}).toEqual(canonical.entitled))
  expect(result.current.member?.downloads ?? null).toBe(false)
  expect(result.current.member?.invited_at ?? null).toBe(canonical.invited_at)
})

test('tier changes reconcile entitlements and retain a downloads override', async () => {
  const { result, client } = setup()
  const canonical: Member = {
    ...member,
    tier: 'youth',
    entitled: { Meleys: ['03. Family Movies'] },
  }
  vi.mocked(api.resetTier).mockResolvedValue({ email: member.email, tier: 'youth' })
  vi.mocked(api.fetchMember).mockResolvedValue(canonical)
  act(() => result.current.actions.hardReset.mutate('youth'))
  await waitFor(() => expect(result.current.member?.entitled ?? {}).toEqual(canonical.entitled))
  expect(result.current.member?.downloads ?? null).toBe(false)
  expect(client.getQueryState(MEMBERS_QUERY_KEY)?.isInvalidated ?? false).toBe(true)
})
