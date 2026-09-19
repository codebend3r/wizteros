import { afterEach, expect, test, vi } from '@/test/vi'
import {
  fetchNeverPlayed,
  fetchPlaySync,
  fetchPlayUsers,
  fetchPlaysOverview,
  fetchTitleHistory,
  fetchTopTitles,
  fetchViewerHistory,
  PLAY_KINDS,
  PLAY_QUALITIES,
  PLAY_RANGES,
  playsQuery,
  rangeProse,
  windowProse,
  type NeverPlayed,
  type PlaysFilters,
  type PlaysOverview,
  type TitleHistory,
  type TopTitle,
} from '@/lib/playsApi'

// The monitor authorizes every read off the Supabase session, so stub the
// client for authHeader() to draw a token from. Declared here rather than
// leaned on from another file: bun's mock.module is process-global and leaks
// forward between files, which would leave these assertions passing only
// because of the order the suite happens to run in.
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

const JSON_HEADERS = { get: () => 'application/json' }

const ALL: PlaysFilters = { days: 365, host: '', kind: '', quality: '' }

const title: TopTitle = {
  key: 'movie:Inception:2010',
  kind: 'movie',
  title: 'Inception',
  context: null,
  year: 2010,
  quality: '4k',
  plays: 12,
  viewers: 7,
  items: 1,
  rewatches: 5,
  top_rewatcher: { account_id: 1, name: 'cj', plays: 3 },
  last_viewed_at: '2026-09-17T20:11:00+00:00',
  hosts: ['meleys'],
  thumb: null,
}

const overview: PlaysOverview = {
  window: { days: 365, since: '2025-09-18T00:00:00+00:00', host: null, kind: null, quality: null },
  totals: { plays: 8341, viewers: 41, titles: 2210, watch_ms: 3_600_000 * 1234 },
  by_kind: [
    { kind: 'movie', plays: 3000 },
    { kind: 'episode', plays: 5000 },
    { kind: 'track', plays: 341 },
  ],
  by_quality: [
    { quality: '4k', plays: 1000 },
    { quality: '1080p', plays: 6000 },
    { quality: '720p', plays: 500 },
    { quality: 'other', plays: 500 },
  ],
  by_host: [
    { host: 'meleys', friendly_name: 'Meleys', plays: 1599 },
    { host: 'caraxes', friendly_name: 'Caraxes', plays: 4109 },
  ],
  timeline: {
    bucket: 'month',
    points: [{ start: '2026-09-01', plays: 12, hosts: { meleys: 5, caraxes: 7 } }],
  },
  top_viewers: [{ account_id: 1, name: 'cj', plays: 500 }],
  top_titles: [title],
}

const stubJson = (payload: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: JSON_HEADERS,
      json: async () => payload,
    })),
  )

afterEach(() => {
  vi.restoreAllMocks()
})

test('the ranges run from a week to all time, with all time last', () => {
  expect(PLAY_RANGES.map((range) => range.days)).toEqual([7, 30, 90, 365, 0])
  expect(PLAY_KINDS.map((kind) => kind.kind)).toEqual(['', 'movie', 'episode', 'track'])
  expect(PLAY_QUALITIES.map((quality) => quality.quality)).toEqual([
    '',
    '4k',
    '1080p',
    '720p',
    'other',
  ])
})

test('a range reads as a span mid-sentence', () => {
  expect(rangeProse(365)).toBe('year')
  expect(rangeProse(0)).toBe('all time')
  expect(windowProse(30)).toBe('over the last 30 days')
  expect(windowProse(0)).toBe('across all time')
})

test('playsQuery always sends days and omits the filters left empty', () => {
  expect(playsQuery(ALL)).toBe('days=365')
  // 0 is a value, all time, and must travel rather than read as unset
  expect(playsQuery({ days: 0, host: 'meleys', kind: 'movie', quality: '4k' })).toBe(
    'days=0&host=meleys&kind=movie&quality=4k',
  )
})

test('playsQuery appends a read’s own parameters after the shared filters', () => {
  expect(playsQuery({ ...ALL, days: 30, extra: { metric: 'rewatches', limit: 25 } })).toBe(
    'days=30&metric=rewatches&limit=25',
  )
})

test('fetchPlaysOverview reads the overview with the session bearer', async () => {
  stubJson(overview)

  await expect(fetchPlaysOverview({ filters: ALL })).resolves.toEqual(overview)
  expect(globalThis.fetch).toHaveBeenCalledWith('/plays/overview?days=365', {
    headers: { Authorization: 'Bearer tok123' },
  })
})

test('fetchPlaysOverview refuses a payload that is not an overview', async () => {
  stubJson({ ...overview, timeline: { bucket: 'fortnight', points: [] } })

  await expect(fetchPlaysOverview({ filters: ALL })).rejects.toThrow(/Unexpected play history/)
})

test('a 401 names the session rather than a status code', async () => {
  stubJson({}, 401)

  await expect(fetchPlaySync()).rejects.toThrow(/Not signed in/)
})

test('fetchPlayUsers sends the filters and accepts the spec shape', async () => {
  const users = {
    users: [
      {
        account_id: 1,
        name: 'cj',
        thumb: null,
        plays: 500,
        movies: 100,
        episodes: 380,
        tracks: 20,
        hosts: ['meleys', 'syrax'],
        last_viewed_at: '2026-09-17T20:11:00+00:00',
        top_title: 'Better Call Saul',
      },
    ],
  }
  stubJson(users)

  await expect(fetchPlayUsers({ filters: { ...ALL, kind: 'episode' } })).resolves.toEqual(users)
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/plays/users?days=365&kind=episode',
    expect.anything(),
  )
})

test('fetchViewerHistory pages one viewer and refuses another viewer’s answer', async () => {
  const history = {
    account_id: 42,
    name: 'danny',
    total: 1,
    page: 2,
    page_size: 50,
    rows: [
      {
        viewed_at: '2026-09-17T20:11:00+00:00',
        host: 'meleys',
        kind: 'episode',
        group_key: 'show:better call saul',
        title: 'Smoke',
        parent_title: 'Season 4',
        grandparent_title: 'Better Call Saul',
        index: 1,
        parent_index: 4,
        year: 2018,
        quality: '1080p',
        device: 'Chrome',
        library: '06. TV Shows',
        duration_ms: 3_000_000,
      },
    ],
  }
  stubJson(history)

  await expect(
    fetchViewerHistory({ filters: ALL, accountId: 42, page: 2, pageSize: 50 }),
  ).resolves.toEqual(history)
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/plays/users/42/history?days=365&page=2&page_size=50',
    expect.anything(),
  )

  await expect(
    fetchViewerHistory({ filters: ALL, accountId: 7, page: 1, pageSize: 50 }),
  ).rejects.toThrow(/viewer 7 and got 42/)
})

test('fetchTitleHistory pages one title and refuses another title’s answer', async () => {
  const history: TitleHistory = {
    key: 'movie:heat:1995',
    kind: 'movie',
    title: 'Heat',
    context: null,
    year: 1995,
    quality: '4k',
    viewers: 2,
    items: 1,
    rewatches: 1,
    first_viewed_at: '2026-01-02T20:11:00+00:00',
    last_viewed_at: '2026-09-17T20:11:00+00:00',
    hosts: ['meleys'],
    total: 3,
    page: 1,
    page_size: 50,
    rows: [
      {
        viewed_at: '2026-09-17T20:11:00+00:00',
        host: 'meleys',
        kind: 'movie',
        account_id: 42,
        viewer: 'danny',
        title: 'Heat',
        index: null,
        parent_index: null,
        year: 1995,
        quality: '4k',
        device: 'Chrome',
        library: '01. 4K Movies',
        duration_ms: 10_000_000,
      },
    ],
  }
  stubJson(history)

  await expect(
    fetchTitleHistory({ filters: ALL, titleKey: 'movie:heat:1995', page: 1, pageSize: 50 }),
  ).resolves.toEqual(history)
  // the key carries the title itself, so it has to reach the monitor encoded
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/plays/title?days=365&key=movie%3Aheat%3A1995&page=1&page_size=50',
    expect.anything(),
  )

  await expect(
    fetchTitleHistory({ filters: ALL, titleKey: 'show:qi', page: 1, pageSize: 50 }),
  ).rejects.toThrow(/show:qi and got movie:heat:1995/)
})

test('fetchTopTitles asks for one metric and refuses the other', async () => {
  stubJson({ metric: 'plays', titles: [title] })

  await expect(fetchTopTitles({ filters: ALL, metric: 'plays', limit: 25 })).resolves.toEqual({
    metric: 'plays',
    titles: [title],
  })
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/plays/top?days=365&metric=plays&limit=25',
    expect.anything(),
  )

  await expect(fetchTopTitles({ filters: ALL, metric: 'rewatches', limit: 25 })).rejects.toThrow(
    /by rewatches and got plays/,
  )
})

test('fetchNeverPlayed sends the search term only when there is one', async () => {
  const never: NeverPlayed = {
    summary: {
      movies: 120,
      shows: 30,
      albums: 900,
      by_quality: [{ quality: '4k', count: 20 }],
      by_host: [{ host: 'meleys', count: 100 }],
    },
    total: 1050,
    page: 1,
    page_size: 50,
    rows: [
      {
        key: 'meleys:12345',
        host: 'meleys',
        kind: 'movie',
        title: 'The Matrix',
        context: null,
        year: 1999,
        quality: '4k',
        library: '01. 4K Movies',
        added_at: '2026-09-01T00:00:00+00:00',
        items: 1,
        thumb: null,
      },
    ],
  }
  stubJson(never)

  await expect(fetchNeverPlayed({ filters: ALL, page: 1, pageSize: 50, q: '' })).resolves.toEqual(
    never,
  )
  expect(globalThis.fetch).toHaveBeenCalledWith(
    '/plays/never-played?days=365&page=1&page_size=50',
    expect.anything(),
  )

  await fetchNeverPlayed({ filters: ALL, page: 1, pageSize: 50, q: 'the matrix' })
  expect(globalThis.fetch).toHaveBeenLastCalledWith(
    '/plays/never-played?days=365&page=1&page_size=50&q=the+matrix',
    expect.anything(),
  )
})

test('fetchPlaySync accepts the spec shape and refuses a wrong one', async () => {
  const sync = {
    lookback_days: 365,
    servers: [
      {
        host: 'meleys',
        friendly_name: 'Meleys',
        plex_url: 'http://192.168.50.2:32400',
        reachable: true,
        history_synced_at: '2026-09-18T04:00:00+00:00',
        library_synced_at: null,
        history_since: '2025-09-18T04:00:00+00:00',
        plays: 1599,
        items: 55_000,
        last_error: null,
      },
    ],
  }
  stubJson(sync)
  await expect(fetchPlaySync()).resolves.toEqual(sync)

  stubJson({ lookback_days: 365, servers: 'nope' })
  await expect(fetchPlaySync()).rejects.toThrow(/Unexpected sync status/)
})
