import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import type {
  NeverPlayed,
  PlaySync,
  PlaySyncServer,
  PlayUsers,
  PlaysOverview,
  TopTitle,
  TopTitles,
  ViewerHistory,
} from '@/lib/playsApi'
import { Plays } from '@/pages/Plays/Plays'
import { useAuthStore } from '@/stores/authStore'
import { DEFAULT_RANGE_DAYS, DEFAULT_TAB, usePlaysPrefsStore } from '@/stores/playsPrefsStore'

const HOSTS = ['meleys', 'vermithor', 'caraxes', 'syrax', 'vhagar'] as const

const server = (host: string, extra: Partial<PlaySyncServer> = {}): PlaySyncServer => ({
  host,
  friendly_name: host,
  plex_url: `http://${host}:32400`,
  reachable: true,
  history_synced_at: '2026-09-18T12:00:00+00:00',
  library_synced_at: '2026-09-18T06:00:00+00:00',
  history_since: '2025-09-18T00:00:00+00:00',
  plays: 100,
  items: 500,
  last_error: null,
  ...extra,
})

const SYNC: PlaySync = { lookback_days: 365, servers: HOSTS.map((host) => server(host)) }

const heat: TopTitle = {
  key: 'movie:heat:1995',
  kind: 'movie',
  title: 'Heat',
  context: null,
  year: 1995,
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

const OVERVIEW: PlaysOverview = {
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
  by_host: HOSTS.map((host, index) => ({ host, friendly_name: host, plays: 100 * (index + 1) })),
  timeline: {
    bucket: 'month',
    points: [
      { start: '2026-08-01', plays: 40, hosts: { meleys: 30, syrax: 10 } },
      { start: '2026-09-01', plays: 25, hosts: { meleys: 25 } },
    ],
  },
  top_viewers: [
    { account_id: 1, name: 'cj', plays: 500 },
    { account_id: 42, name: 'Ann', plays: 120 },
  ],
  top_titles: [heat],
}

const USERS: PlayUsers = {
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
    {
      account_id: 42,
      name: 'Ann',
      thumb: null,
      plays: 120,
      movies: 120,
      episodes: 0,
      tracks: 0,
      hosts: ['caraxes'],
      last_viewed_at: '2026-09-10T09:00:00+00:00',
      top_title: 'Heat',
    },
  ],
}

const HISTORY: ViewerHistory = {
  account_id: 1,
  name: 'cj',
  total: 2,
  page: 1,
  page_size: 50,
  rows: [
    {
      viewed_at: '2026-09-17T20:11:00+00:00',
      host: 'meleys',
      kind: 'movie',
      title: 'Heat',
      parent_title: null,
      grandparent_title: null,
      index: null,
      parent_index: null,
      year: 1995,
      quality: '4k',
      device: 'Chrome',
      library: '01. 4K Movies',
      duration_ms: 10_000_000,
    },
    {
      viewed_at: '2026-09-16T21:00:00+00:00',
      host: 'meleys',
      kind: 'episode',
      title: 'Smoke',
      parent_title: 'Season 4',
      grandparent_title: 'Better Call Saul',
      index: 1,
      parent_index: 4,
      year: 2018,
      quality: '1080p',
      device: null,
      library: '06. TV Shows',
      duration_ms: 2_800_000,
    },
  ],
}

const TOP: TopTitles = { metric: 'plays', titles: [heat] }

const NEVER: NeverPlayed = {
  summary: {
    movies: 1,
    shows: 0,
    albums: 0,
    by_quality: [
      { quality: '4k', count: 1 },
      { quality: '1080p', count: 0 },
      { quality: '720p', count: 0 },
      { quality: 'other', count: 0 },
    ],
    by_host: HOSTS.map((host) => ({ host, count: host === 'meleys' ? 1 : 0 })),
  },
  total: 2,
  page: 1,
  page_size: 50,
  rows: [
    {
      key: 'meleys:movie:9',
      host: 'meleys',
      kind: 'movie',
      title: 'Dune',
      context: null,
      year: 2021,
      quality: '4k',
      library: '01. 4K Movies',
      added_at: '2026-09-01T00:00:00+00:00',
      items: 1,
      thumb: null,
    },
    {
      key: 'syrax:show:40',
      host: 'syrax',
      kind: 'show',
      title: 'QI',
      context: null,
      year: null,
      quality: null,
      library: '04. Light Night/Comedy Shows',
      // the monitor sends no date where the server dated an item impossibly,
      // or not at all
      added_at: null,
      items: 253,
      thumb: null,
    },
  ],
}

type Payloads = {
  readonly sync?: unknown
  readonly overview?: unknown
  readonly users?: unknown
  readonly history?: unknown
  /** Answered per request, because the same route serves both rankings and
      the fetcher refuses a payload ranked by the other metric. */
  readonly top?: (url: string) => unknown
  readonly never?: unknown
}

const jsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

// Every query goes through the same window.fetch, so route the stub by path
// rather than by call order. A viewer's history sits under /plays/users, so
// it is matched first.
const stubPlaysFetch = (payloads: Payloads = {}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/plays/sync')) return jsonResponse(payloads.sync ?? SYNC)
      if (url.startsWith('/plays/overview')) return jsonResponse(payloads.overview ?? OVERVIEW)
      if (/^\/plays\/users\/\d+\/history/.test(url)) {
        return jsonResponse(payloads.history ?? HISTORY)
      }
      if (url.startsWith('/plays/users')) return jsonResponse(payloads.users ?? USERS)
      if (url.startsWith('/plays/top')) return jsonResponse(payloads.top?.(url) ?? TOP)
      if (url.startsWith('/plays/never-played')) return jsonResponse(payloads.never ?? NEVER)
      throw new Error(`unexpected request ${url}`)
    }),
  )

const calledPaths = (): readonly string[] =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.flatMap((call) => (typeof call[0] === 'string' ? [call[0]] : []))

// AdminLayout brings the header, sidebar and footer, so the page needs a
// router; the gate is dormant while Supabase is unconfigured, as in every
// other page suite.
const renderPlays = (entry = '/plays') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.setState({ enabled: false })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Plays />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  // the prefs store is a module singleton shared by every test in the file,
  // and the selected tab and filters persist
  usePlaysPrefsStore.setState({
    rangeDays: DEFAULT_RANGE_DAYS,
    host: '',
    kind: '',
    quality: '',
    tab: DEFAULT_TAB,
  })
  localStorage.removeItem('wz-plays-prefs')
})

test('Plays says it is loading while the first payloads are in flight', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  renderPlays()

  expect(screen.getByRole('heading', { level: 1, name: 'Play history' })).toBeInTheDocument()
  expect(screen.getByText('Checking the collector.')).toBeInTheDocument()
  expect(screen.getByText('Loading play history.')).toBeInTheDocument()
})

test('Plays reports an unreachable monitor rather than an empty ledger', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
  renderPlays()

  expect(await screen.findByText(/Sync status is unavailable/)).toBeInTheDocument()
  expect(await screen.findByText(/No overview is available/)).toBeInTheDocument()
  // the filters stay reachable while the reads fail
  expect(screen.getByRole('button', { name: '30 days' })).toBeInTheDocument()
})

test('Plays reads a ledger nobody has filled yet as the collector backfilling', async () => {
  stubPlaysFetch({
    sync: {
      lookback_days: 365,
      servers: HOSTS.map((host) =>
        server(host, {
          friendly_name: null,
          reachable: false,
          history_synced_at: null,
          library_synced_at: null,
          history_since: null,
          plays: 0,
          items: 0,
        }),
      ),
    },
  })
  renderPlays()

  expect(
    await screen.findByText(/The collector is backfilling play history from 5 servers/),
  ).toBeInTheDocument()
})

test('Plays renders the overview tiles, the timeline and the breakdowns once the payload lands', async () => {
  stubPlaysFetch()
  renderPlays()

  expect(await screen.findByText('8,341')).toBeInTheDocument()
  expect(screen.getByText('41')).toBeInTheDocument()
  expect(screen.getByText('2,210')).toBeInTheDocument()
  expect(screen.getByText('1,234 h')).toBeInTheDocument()
  expect(screen.getByText(/500 completed plays since/)).toBeInTheDocument()
  expect(
    screen.getByRole('img', { name: /Completed plays per month by server over the last year/ }),
  ).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'By quality' })).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'By server' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'cj' })).toBeInTheDocument()
  expect(screen.getByText('Heat (1995)')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('Plays names a server whose last pass failed, with the reason', async () => {
  stubPlaysFetch({
    sync: {
      lookback_days: 365,
      servers: HOSTS.map((host) =>
        host === 'vhagar'
          ? server(host, { reachable: false, last_error: 'refused' })
          : server(host),
      ),
    },
  })
  renderPlays()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Sync failed on vhagar (refused)')
})

test('Plays offers five views and mounts only the selected one', async () => {
  stubPlaysFetch()
  renderPlays()

  const tabs = await screen.findAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Overview',
    'Viewers',
    'Most played',
    'Most rewatched',
    'Never played',
  ])
  expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  await screen.findByText('8,341')
  expect(calledPaths()).not.toContain('/plays/users?days=365')

  fireEvent.click(screen.getByRole('tab', { name: 'Viewers' }))

  await waitFor(() => expect(calledPaths()).toContain('/plays/users?days=365'))
  expect(await screen.findByRole('button', { name: 'cj, view history' })).toBeInTheDocument()
  expect(screen.getByText('Better Call Saul')).toBeInTheDocument()
  expect(screen.queryByText('8,341')).toBeNull()
  expect(usePlaysPrefsStore.getState().tab).toBe('viewers')
})

test('Plays sends a pressed filter to the monitor and marks it on the toolbar', async () => {
  stubPlaysFetch()
  renderPlays()
  await screen.findByText('8,341')

  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  await waitFor(() => expect(calledPaths()).toContain('/plays/overview?days=30'))
  expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '1 year' })).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(screen.getByRole('button', { name: 'Movies' }))
  fireEvent.click(screen.getByRole('button', { name: '4K' }))
  await waitFor(() =>
    expect(calledPaths()).toContain('/plays/overview?days=30&kind=movie&quality=4k'),
  )

  fireEvent.change(screen.getByRole('combobox', { name: 'Server' }), {
    target: { value: 'syrax' },
  })
  await waitFor(() =>
    expect(calledPaths()).toContain('/plays/overview?days=30&host=syrax&kind=movie&quality=4k'),
  )
  expect(usePlaysPrefsStore.getState().host).toBe('syrax')
})

test('Plays opens a viewer from the viewers table, keeps them in the url, and comes back', async () => {
  stubPlaysFetch()
  usePlaysPrefsStore.setState({ tab: 'viewers' })
  renderPlays()

  fireEvent.click(await screen.findByRole('button', { name: 'cj, view history' }))

  await waitFor(() =>
    expect(calledPaths()).toContain('/plays/users/1/history?days=365&page=1&page_size=50'),
  )
  expect(await screen.findByRole('heading', { name: 'Viewer history' })).toBeInTheDocument()
  expect(screen.getByText('Heat (1995)')).toBeInTheDocument()
  // the show over the episode, the code and the episode title under it
  expect(screen.getByText('Better Call Saul')).toBeInTheDocument()
  expect(screen.getByText('S4 E1 Smoke')).toBeInTheDocument()
  expect(screen.getByText('Chrome')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Back to viewers' }))

  expect(await screen.findByRole('button', { name: 'cj, view history' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Viewer history' })).toBeNull()
})

test('Plays lands on a viewer named in the url, whatever tab was remembered', async () => {
  stubPlaysFetch()
  // a shared link has to open on the viewer it names, not on the tab the
  // browser last had open
  usePlaysPrefsStore.setState({ tab: 'never' })
  renderPlays('/plays?user=1')

  expect(await screen.findByRole('heading', { name: 'Viewer history' })).toBeInTheDocument()
  expect(screen.getByText(/2 completed plays over the last year/)).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Viewers' })).toHaveAttribute('aria-selected', 'true')

  // choosing another view lets the viewer go, so the url and the strip agree
  fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))

  expect(await screen.findByText('8,341')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Viewers' }))
  expect(await screen.findByRole('button', { name: 'cj, view history' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Viewer history' })).toBeNull()
})

test('Plays ranks titles by the chosen metric and says why a rewatch count is empty', async () => {
  stubPlaysFetch({
    top: (url) => (url.includes('metric=rewatches') ? { metric: 'rewatches', titles: [] } : TOP),
  })
  usePlaysPrefsStore.setState({ tab: 'rewatched' })
  renderPlays()

  await waitFor(() =>
    expect(calledPaths()).toContain('/plays/top?days=365&metric=rewatches&limit=25'),
  )
  expect(
    await screen.findByText(/Nothing was completed twice by the same viewer over the last year/),
  ).toBeInTheDocument()

  fireEvent.click(screen.getByRole('tab', { name: 'Most played' }))

  expect(await screen.findByText('Heat (1995)')).toBeInTheDocument()
  expect(screen.getByText(/most by cj, 3 plays/)).toBeInTheDocument()
})

test('Plays lists what was never played with its counts, and searches it', async () => {
  stubPlaysFetch()
  usePlaysPrefsStore.setState({ tab: 'never' })
  renderPlays()

  expect(await screen.findByText('Dune (2021)')).toBeInTheDocument()
  expect(screen.getByText(/No completed play in the last year/)).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Movies by quality' })).toBeInTheDocument()
  expect(screen.getByText('2 titles')).toBeInTheDocument()
  // an undated item was not "never" added: it is one the server did not date
  expect(screen.getByText('unknown')).toBeInTheDocument()
  expect(screen.queryByText('never')).toBeNull()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search titles' }), {
    target: { value: 'dune' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))

  await waitFor(() =>
    expect(calledPaths()).toContain('/plays/never-played?days=365&page=1&page_size=50&q=dune'),
  )
})

test('Plays says so when nothing on the shelves is unplayed', async () => {
  stubPlaysFetch({
    never: {
      ...NEVER,
      summary: { ...NEVER.summary, movies: 0, by_quality: [], by_host: [] },
      total: 0,
      rows: [],
    },
  })
  usePlaysPrefsStore.setState({ tab: 'never' })
  renderPlays()

  expect(
    await screen.findByText('Everything on the shelves has been played at least once.'),
  ).toBeInTheDocument()
})

test('Plays leaves the hard refresh off, since it polls on its own clock', async () => {
  stubPlaysFetch()
  renderPlays()

  await screen.findByText('8,341')
  expect(screen.queryByRole('button', { name: 'Hard refresh' })).toBeNull()
})
