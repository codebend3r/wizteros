import { describe, expect, it } from 'vitest'
import {
  EXPIRY_DAYS_HONORED,
  type Fetch,
  honoredExpiryDays,
  USER_WRITE_TIMEOUT,
  WizarrHttpError,
  wizarrClient,
} from '@/clients/wizarr.js'
import type { WizarrApi } from '@/types.js'

const BASE = 'http://wizarr.test'

// The Python suite faked HTTP with `responses`; this is the same idea. A
// table maps "METHOD url" (query string left off) to an answer, every call is
// recorded, and a call nothing registered fails the way `responses` refused
// an unmatched request, so no test can reach the network.

type Answer = Readonly<{ status?: number; json: unknown }>

type Recorded = Readonly<{
  method: string
  url: string
  headers: Headers
  body: unknown
  hasSignal: boolean
  timeout: number | null
}>

type Route = (url: URL) => Answer

type FakeHttp = {
  routes: Map<string, Route>
  calls: Recorded[]
  timeouts: number[]
}

const fakeHttp = (): FakeHttp => ({ routes: new Map(), calls: [], timeouts: [] })

/** Answer `method` on `path` with a fixed body, `responses.get(...)` style. */
const on = ({
  http,
  method,
  path,
  json,
  status = 200,
}: {
  http: FakeHttp
  method: string
  path: string
  json: unknown
  status?: number
}): void => {
  http.routes.set(`${method} ${BASE}${path}`, () => ({ status, json }))
}

/** A fetch that answers from the table and records what it was sent. */
const fetchFor =
  (http: FakeHttp): Fetch =>
  async (url, init) => {
    const parsed = new URL(url)
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    http.calls.push({
      method,
      url,
      headers: new Headers(init.headers),
      body,
      hasSignal: init.signal instanceof AbortSignal,
      timeout: http.timeouts.at(-1) ?? null,
    })
    const route = http.routes.get(`${method} ${parsed.origin}${parsed.pathname}`)
    if (route === undefined) {
      throw new TypeError(`connection refused by the fake: ${method} ${url}`)
    }
    const answer = route(parsed)
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

/** Fresh client pointed at the fake base URL. */
const client = (http: FakeHttp): WizarrApi =>
  wizarrClient({
    baseUrl: BASE,
    apiKey: 'key',
    fetch: fetchFor(http),
    timeoutSignal: (seconds) => {
      http.timeouts.push(seconds)
      return new AbortController().signal
    },
  })

type UserRow = Readonly<{ id: number; username: string; email: string | null; server: string }>

/**
 * Mock /api/users with Wizarr's server-side username filtering.
 *
 * Live Wizarr filters on a username query param; a repr string like
 * "<User 281>" matches no username and comes back empty. The mock has to
 * reproduce that or a username lookup on the repr looks like it works.
 */
const usersLikeWizarr = ({ http, users }: { http: FakeHttp; users: readonly UserRow[] }): void => {
  http.routes.set(`GET ${BASE}/api/users`, (url) => {
    const wanted = url.searchParams.get('username')
    return { json: { users: users.filter((user) => !wanted || user.username === wanted) } }
  })
}

describe('createInvite', () => {
  it('scopes libraries and downloads', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'POST',
      path: '/api/invitations',
      json: { invitation: { id: 5, code: 'abc123', url: `${BASE}/j/abc123` } },
      status: 201,
    })
    const out = await client(http).createInvite({
      serverIds: [1, 2],
      expiresInDays: 7,
      duration: '35',
      libraryIds: [17, 20],
      allowDownloads: true,
    })
    expect(out).toEqual({ code: 'abc123', url: `${BASE}/j/abc123` })
    const sent = http.calls[0]?.body
    expect(sent).toEqual({
      server_ids: [1, 2],
      expires_in_days: 7,
      duration: '35',
      unlimited: false,
      allow_downloads: true,
      library_ids: [17, 20],
    })
  })

  it('sends the snapped expiry, not the requested one', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'POST',
      path: '/api/invitations',
      json: { invitation: { id: 7, code: 'ghi789', url: `${BASE}/j/ghi789` } },
      status: 201,
    })
    await client(http).createInvite({
      serverIds: [1],
      expiresInDays: 2,
      duration: '35',
      unlimited: true,
    })
    expect(http.calls[0]?.body).toMatchObject({ expires_in_days: 7 })
  })

  it('omits library_ids when unscoped', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'POST',
      path: '/api/invitations',
      json: { invitation: { id: 6, code: 'def456', url: `${BASE}/j/def456` } },
      status: 201,
    })
    await client(http).createInvite({ serverIds: [1], expiresInDays: 7, duration: '35' })
    const sent = http.calls[0]?.body
    expect(sent).not.toHaveProperty('library_ids')
    expect(sent).toMatchObject({ allow_downloads: false })
  })

  it('sends the payload keys in the order the Python built them', async () => {
    // not a Python test: pins the wire order the port promised to keep
    const http = fakeHttp()
    on({
      http,
      method: 'POST',
      path: '/api/invitations',
      json: { invitation: { code: 'k', url: `${BASE}/j/k` } },
    })
    await client(http).createInvite({
      serverIds: [1],
      expiresInDays: 7,
      duration: '35',
      libraryIds: [3],
    })
    const sent = http.calls[0]?.body
    expect(Object.keys(typeof sent === 'object' && sent !== null ? sent : {})).toEqual([
      'server_ids',
      'expires_in_days',
      'duration',
      'unlimited',
      'allow_downloads',
      'library_ids',
    ])
  })
})

describe('honoredExpiryDays', () => {
  it('snaps an unhonored expiry up to one Wizarr keeps', () => {
    // Wizarr's lookup is {1, 7, 30}; every other number becomes "never".
    //
    // That is the whole hazard: the API does not reject an expiry it cannot
    // express, it drops it, so asking for 2 days yields a link redeemable
    // forever. Snapping up is the safe direction, since a shorter window can
    // kill a paying member's invite before they redeem it.
    expect(honoredExpiryDays(2)).toBe(7) // the baseline rotation's default
    expect(honoredExpiryDays(14)).toBe(30) // INVITE_EXPIRES_DAYS' default
    expect(honoredExpiryDays(8)).toBe(30)
  })

  it('leaves an expiry Wizarr already honors alone', () => {
    expect(EXPIRY_DAYS_HONORED.map(honoredExpiryDays)).toEqual([...EXPIRY_DAYS_HONORED])
  })

  it('takes the longest option, not never, for an expiry past it', () => {
    // There is no finite choice above 30, and "never" is not a fallback.
    //
    // Landing on the longest expiry Wizarr has is worse than what was asked for
    // and better than the link outliving the server.
    expect(honoredExpiryDays(365)).toBe(30)
  })
})

describe('listLibraries', () => {
  it('returns the raw library rows', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/libraries',
      json: {
        libraries: [
          { id: 17, name: '01. TV Shows', server_id: 1, server_name: 'Vermithor', enabled: true },
          { id: 37, name: '99. Tutorials', server_id: 4, server_name: 'Caraxes', enabled: true },
        ],
      },
    })
    const libs = await client(http).listLibraries()
    expect(libs.map((lib) => lib.id)).toEqual([17, 37])
    expect(libs[0]?.server_name).toBe('Vermithor')
  })
})

describe('findUserIdsByEmail', () => {
  it('returns all matching records', async () => {
    // One email maps to one record per server; return every matching id.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/users',
      json: {
        users: [
          { id: 9, username: 'cj', email: 'a@x.com', server: 'Meleys' },
          { id: 12, username: 'cj', email: 'a@x.com', server: 'Vhagar' },
          { id: 3, username: 'other', email: 'other@x.com', server: 'Meleys' },
        ],
      },
    })
    expect(await client(http).findUserIdsByEmail('a@x.com')).toEqual([9, 12])

    const reset = fakeHttp()
    on({ http: reset, method: 'GET', path: '/api/users', json: { users: [] } })
    expect(await client(reset).findUserIdsByEmail('nope@x.com')).toEqual([])
  })

  it('matches case-insensitively and skips null emails', async () => {
    // Stripe and Plex emails can differ in case; Wizarr records can lack one.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/users',
      json: {
        users: [
          { id: 9, username: 'cj', email: 'A@X.com', server: 'Meleys' },
          { id: 12, username: 'local', email: null, server: 'Vhagar' },
        ],
      },
    })
    expect(await client(http).findUserIdsByEmail('a@x.com')).toEqual([9])
  })

  it('sends the email as a query param encoded the way requests does', async () => {
    // not a Python test: requests' urlencode turns "@" into %40 and a space
    // into "+", and escapes the `!*'()` that encodeURIComponent leaves alone
    const http = fakeHttp()
    on({ http, method: 'GET', path: '/api/users', json: { users: [] } })
    await client(http).findUsersByEmail("o'neil+x@a.com")
    expect(http.calls[0]?.url).toBe(`${BASE}/api/users?email=o%27neil%2Bx%40a.com`)
  })
})

describe('findUserIdsByInvite', () => {
  it('walks used_by and returns all records', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: 'cj' }] },
    })
    on({
      http,
      method: 'GET',
      path: '/api/users',
      json: {
        users: [
          { id: 9, username: 'cj', email: 'a@x.com', server: 'Meleys' },
          { id: 12, username: 'cj', email: 'a@x.com', server: 'Vhagar' },
        ],
      },
    })
    expect(await client(http).findUserIdsByInvite('abc123')).toEqual([9, 12])

    const reset = fakeHttp()
    on({
      http: reset,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: null }] },
    })
    expect(await client(reset).findUserIdsByInvite('abc123')).toEqual([])
  })

  it('resolves the User repr to all records', async () => {
    // The live Wizarr serializes used_by through fields.String over a User
    // relationship with no __str__, so the API returns "<User 281>", not a
    // username. The number is the redeeming record's id; matching it as a
    // username can never succeed.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: '<User 281>' }] },
    })
    usersLikeWizarr({
      http,
      users: [
        { id: 281, username: 'cj', email: 'a@x.com', server: 'Meleys' },
        { id: 300, username: 'cj', email: 'A@x.com', server: 'Vhagar' },
        { id: 3, username: 'other', email: 'other@x.com', server: 'Meleys' },
      ],
    })
    expect(await client(http).findUserIdsByInvite('abc123')).toEqual([281, 300])
  })

  it('returns the one record when the repr resolves to a record without email', async () => {
    // A record with no email can't fan out to sibling servers; still time-box
    // the one record that redeemed the invite.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: '<User 281>' }] },
    })
    usersLikeWizarr({ http, users: [{ id: 281, username: 'cj', email: null, server: 'Meleys' }] })
    expect(await client(http).findUserIdsByInvite('abc123')).toEqual([281])
  })

  it('tolerates a padded repr', async () => {
    // The JS mirrors (sales-agent, member-triage, stripe-reconcile) accept the
    // repr with surrounding whitespace; the bridge is the enforcement path and
    // must classify the same strings the same way.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: ' <User 281> ' }] },
    })
    usersLikeWizarr({
      http,
      users: [{ id: 281, username: 'cj', email: 'a@x.com', server: 'Meleys' }],
    })
    expect(await client(http).findUserIdsByInvite('abc123')).toEqual([281])
  })

  it('returns nothing when the repr names a missing record', async () => {
    // The redeeming record can vanish (member removed); a dead id must not be
    // handed to set_expiry, and no other member's record may stand in for it.
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/invitations',
      json: { invitations: [{ code: 'abc123', used_by: '<User 281>' }] },
    })
    usersLikeWizarr({
      http,
      users: [{ id: 3, username: 'other', email: 'other@x.com', server: 'Meleys' }],
    })
    expect(await client(http).findUserIdsByInvite('abc123')).toEqual([])
  })
})

describe('errors', () => {
  it('propagates Wizarr HTTP errors', async () => {
    const http = fakeHttp()
    on({ http, method: 'GET', path: '/api/libraries', json: { error: 'boom' }, status: 500 })
    const failure = client(http).listLibraries()
    await expect(failure).rejects.toBeInstanceOf(WizarrHttpError)
    await expect(failure).rejects.toMatchObject({ status: 500, url: `${BASE}/api/libraries` })
  })
})

describe('user writes', () => {
  it('call the correct paths', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'PUT',
      path: '/api/users/9/update-expiry',
      json: { message: 'ok', new_expiry: '2026-08-17T00:00:00+00:00' },
    })
    on({ http, method: 'POST', path: '/api/users/9/disable', json: { message: 'ok' } })
    const wizarr = client(http)
    await wizarr.setExpiry({ userId: 9, expires: '2026-08-17T00:00:00+00:00' })
    await wizarr.disableUser(9)
    expect(http.calls[0]?.url).toBe(`${BASE}/api/users/9/update-expiry`)
    expect(http.calls[0]?.body).toMatchObject({ expires: '2026-08-17T00:00:00+00:00' })
    expect(http.calls[1]?.url).toBe(`${BASE}/api/users/9/disable`)
  })

  it('clear the expiry by omitting the expires key', async () => {
    // Wizarr validates the request body against its schema (expires must be a
    // date-time string), so a literal null is rejected with a 400. Clearing to
    // unlimited works by omitting the key entirely.
    const http = fakeHttp()
    on({
      http,
      method: 'PUT',
      path: '/api/users/9/update-expiry',
      json: { message: 'ok', new_expiry: null },
    })
    await client(http).setExpiry({ userId: 9, expires: null })
    expect(http.calls[0]?.body).toEqual({})
  })

  it('allow for a slow Wizarr', async () => {
    // /api/users/<id>/disable and update-expiry go through the same slow Plex
    // reconcile as /api/users; a 10s ceiling timed out mid-disable in prod and
    // left a checkout half-applied.
    const http = fakeHttp()
    on({ http, method: 'POST', path: '/api/users/7/disable', json: {} })
    on({ http, method: 'PUT', path: '/api/users/7/update-expiry', json: {} })
    const wizarr = client(http)
    await wizarr.disableUser(7)
    await wizarr.setExpiry({ userId: 7, expires: '2026-09-09T00:00:00+00:00' })
    expect(USER_WRITE_TIMEOUT).toBeGreaterThanOrEqual(45)
    expect(http.calls.map((call) => call.hasSignal)).toEqual([true, true])
    expect(http.calls[0]?.timeout).toBeGreaterThanOrEqual(45)
    expect(http.calls[1]?.timeout).toBeGreaterThanOrEqual(45)
  })
})

describe('listUsers', () => {
  it('returns all records', async () => {
    const http = fakeHttp()
    on({
      http,
      method: 'GET',
      path: '/api/users',
      json: {
        users: [
          { id: 9, username: 'cj', email: 'a@x.com', server: 'Meleys', expires: null },
          { id: 12, username: 'cj', email: 'a@x.com', server: 'Vhagar', expires: null },
        ],
      },
    })
    const out = await client(http).listUsers()
    expect(out.map((user) => user.id)).toEqual([9, 12])
  })
})

describe('the wire', () => {
  it('sends the API key and JSON content type on every call', async () => {
    // not a Python test: _headers() rode on every request
    const http = fakeHttp()
    on({ http, method: 'GET', path: '/api/libraries', json: { libraries: [] } })
    on({ http, method: 'DELETE', path: '/api/invitations/4', json: {} })
    const wizarr = client(http)
    await wizarr.listLibraries()
    await wizarr.deleteInvitation(4)
    expect(http.calls.map((call) => call.headers.get('X-API-Key'))).toEqual(['key', 'key'])
    expect(http.calls.map((call) => call.headers.get('Content-Type'))).toEqual([
      'application/json',
      'application/json',
    ])
    expect(http.calls.map((call) => call.timeout)).toEqual([10, 10])
  })
})
