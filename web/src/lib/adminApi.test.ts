import { afterEach, expect, test, vi } from 'vitest'
import {
  AdminAuthError,
  fetchMember,
  fetchMembers,
  reissueInvite,
  resetExpiry,
} from '@/lib/adminApi'

const member = {
  member: 'cj',
  email: 'a@x.com',
  tier: 'gold',
  downloads: true,
  expires: '2026-09-01T00:00:00+00:00',
  servers: ['Meleys'],
  libraries: { Meleys: ['01. Movies'] },
  subscribed: true,
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('fetchMembers sends the password header and returns validated members', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [member] })
  vi.stubGlobal('fetch', fetchMock)

  const result = await fetchMembers({ password: 'secret' })

  expect(result).toEqual([member])
  const [, init] = fetchMock.mock.calls[0]
  expect(init.headers['X-Admin-Password']).toBe('secret')
})

test('fetchMembers throws AdminAuthError on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
  )
  await expect(fetchMembers({ password: 'wrong' })).rejects.toBeInstanceOf(AdminAuthError)
})

test('fetchMember returns null on 404', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
  )
  await expect(fetchMember({ email: 'ghost@x.com', password: 'secret' })).resolves.toBeNull()
})

test('reissueInvite posts email + tier and returns the invite link', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      url: 'http://inv/j/xyz',
      code: 'xyz',
      tier: 'bronze',
      disabled: 1,
      emailed: true,
    }),
  })
  vi.stubGlobal('fetch', fetchMock)

  const result = await reissueInvite({ email: 'a@x.com', tier: 'bronze', password: 'secret' })

  expect(result.url).toBe('http://inv/j/xyz')
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', tier: 'bronze' })
})

test('fetchMembers defaults a missing libraries map (pre-deploy bridge)', async () => {
  const legacyMember = Object.fromEntries(
    Object.entries(member).filter(([key]) => key !== 'libraries'),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [legacyMember] }),
  )
  const result = await fetchMembers({ password: 'secret' })
  expect(result).toEqual([{ ...legacyMember, libraries: {} }])
})

test('fetchMembers rejects a malformed member (missing fields)', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ member: 'cj', email: 'a@x.com' }],
    }),
  )
  await expect(fetchMembers({ password: 'secret' })).rejects.toThrow('Unexpected members response')
})

test('resetExpiry posts email + days and returns the parsed result', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ updated: 2, expires: null }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const result = await resetExpiry({ email: 'a@x.com', days: null, password: 'secret' })
  expect(result).toEqual({ updated: 2, expires: null })
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', days: null })
})
