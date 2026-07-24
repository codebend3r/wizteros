import { afterEach, expect, test, vi } from '@/test/vi'
import {
  AdminAuthError,
  fetchMember,
  fetchMembers,
  fetchPlexAccess,
  type Member,
  reissueInvite,
  resetExpiry,
  setMemberTag,
} from '@/lib/adminApi'

// The bridge is now authorized by the Supabase session; stub the client so
// authHeader() emits a bearer token to assert on.
// mock.module is process-global and cannot be un-registered in bun, so this
// mock leaks into every later test file. It must therefore implement every
// supabase.auth method the app calls (a dangling deauth effect elsewhere would
// otherwise throw "signOut is not a function").
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok123' } } }),
      signOut: async () => ({ error: null }),
      signInWithPassword: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  },
}))

const member: Member = {
  member: 'cj',
  email: 'a@x.com',
  tier: 'gold',
  downloads: true,
  expires: '2026-09-01T00:00:00+00:00',
  servers: ['Meleys'],
  libraries: { Meleys: ['01. Movies'] },
  subscribed: true,
  invited_at: '2026-07-01T00:00:00+00:00',
  tag: null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('fetchMembers sends the bearer token and returns validated members', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [member] })
  vi.stubGlobal('fetch', fetchMock)

  const result = await fetchMembers()

  expect(result).toEqual([member])
  const [, init] = fetchMock.mock.calls[0]
  expect(init.headers.Authorization).toBe('Bearer tok123')
})

test('fetchMembers throws AdminAuthError on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
  )
  await expect(fetchMembers()).rejects.toBeInstanceOf(AdminAuthError)
})

test('fetchMember returns null on 404', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
  )
  await expect(fetchMember({ email: 'ghost@x.com' })).resolves.toBeNull()
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

  const result = await reissueInvite({ email: 'a@x.com', tier: 'bronze' })

  expect(result.url).toBe('http://inv/j/xyz')
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', tier: 'bronze' })
})

test('fetchMembers defaults missing libraries and invited_at (pre-deploy bridge)', async () => {
  const legacyMember = Object.fromEntries(
    Object.entries(member).filter(([key]) => key !== 'libraries' && key !== 'invited_at'),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [legacyMember] }),
  )
  const result = await fetchMembers()
  // Equivalent to legacyMember + the parser's defaults, but typed as Member so
  // bun's strict expect<Member[]> accepts it.
  expect(result).toEqual([{ ...member, libraries: {}, invited_at: null }])
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
  await expect(fetchMembers()).rejects.toThrow('Unexpected members response')
})

test('resetExpiry posts email + days and returns the parsed result', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ updated: 2, expires: null }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const result = await resetExpiry({ email: 'a@x.com', days: null })
  expect(result).toEqual({ updated: 2, expires: null })
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', days: null, expires_at: null })
})

test('fetchMembers defaults a missing tag (pre-tag bridge) and rejects unknown tags', async () => {
  const untagged = Object.fromEntries(Object.entries(member).filter(([key]) => key !== 'tag'))
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [untagged] }),
  )
  await expect(fetchMembers()).resolves.toEqual([{ ...member, tag: null }])

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ ...member, tag: 'whale' }],
    }),
  )
  await expect(fetchMembers()).rejects.toThrow('Unexpected members response')
})

test('setMemberTag posts email + tag and returns the parsed result', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ email: 'a@x.com', tag: 'vip' }),
  })
  vi.stubGlobal('fetch', fetchMock)
  const result = await setMemberTag({ email: 'a@x.com', tag: 'vip' })
  expect(result).toEqual({ email: 'a@x.com', tag: 'vip' })
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', tag: 'vip' })
})

test('fetchPlexAccess returns validated per-server shares', async () => {
  const access = {
    email: 'a@x.com',
    servers: {
      Meleys: { all_libraries: true, allow_sync: true, libraries: ['01. Movies'] },
    },
  }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => access })
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchPlexAccess({ email: 'a@x.com' })).resolves.toEqual(access)
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toContain('/admin/plex-access?email=a%40x.com')
  expect(init.headers.Authorization).toBe('Bearer tok123')
})

test('fetchPlexAccess rejects an unexpected shape', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ email: 'a@x.com', servers: { Meleys: { libraries: 'nope' } } }),
    }),
  )
  await expect(fetchPlexAccess({ email: 'a@x.com' })).rejects.toThrow(
    'Unexpected plex-access response',
  )
})
