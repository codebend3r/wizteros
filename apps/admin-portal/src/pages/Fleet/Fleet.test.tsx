import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import type { FleetHost, HostSummary } from '@/lib/fleetApi'
import { Fleet } from '@/pages/Fleet/Fleet'
import { HostCard } from '@/pages/Fleet/HostCard'
import { useAuthStore } from '@/stores/authStore'
import {
  DEFAULT_CHART_KIND,
  DEFAULT_RANGE_MINUTES,
  DEFAULT_UPDATE_INTERVAL_MS,
  useFleetPrefsStore,
} from '@/stores/fleetPrefsStore'

const summary: HostSummary = {
  name: 'vermithor',
  ip: '192.168.50.3',
  status: 'warn',
  hasGpu: true,
  hasDocker: true,
  cores: 4,
  loadPerCore: 0.12,
  memoryPercent: 29,
  memoryTotalBytes: 16_642_768_896,
  diskPercent: 99,
  diskTotalBytes: 104_258_640_805_888,
  uptimePercent: 100,
  metricsStale: false,
  stalestFamily: 'disk',
  stalestFamilyAgeSeconds: 12,
  containers: [{ name: 'sonarr', up: true, healthy: true, hasHealthcheck: true }],
}

const host: FleetHost = {
  name: 'vermithor',
  ip: '192.168.50.3',
  has_gpu: true,
  has_docker: true,
  collected: true,
  status: 'ok',
  cores: 4,
  load_per_core: 0.115,
  memory_percent: 29,
  memory_total_bytes: 16_642_768_896,
  disk_percent: 62,
  disk_total_bytes: 104_258_640_805_888,
  containers: [{ name: 'sonarr', up: true, healthy: true, has_healthcheck: true }],
  metrics_stale: false,
  stalest_family: 'disk',
  stalest_family_age_seconds: 12,
  uptime_percent_24h: 100,
}

// AdminLayout brings the header, sidebar and footer, so the page needs a
// router; the gate is dormant while Supabase is unconfigured, as in every
// other page suite.
const renderFleet = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.setState({ enabled: false })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/fleet']}>
        <Fleet />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// One chart per kind, so an empty history has to be answerable for each of
// them; the kind has to match the route or the fetcher refuses the payload.
const CHART_KINDS = ['cpu', 'memory', 'gpu', 'network'] as const

const emptyHistory = (kind: string) => ({
  kind,
  unit: kind === 'network' ? 'bytes_per_second' : 'percent',
  window_minutes: 60,
  hosts: [],
})

// Every query goes through the same window.fetch, so route the stub by path
// rather than by call order; the chart routes must be tested before their
// /fleet prefix. `cpu` overrides only the CPU history: the other three stay
// empty, which keeps a test about one chart from having to describe four.
const stubFleetFetch = ({
  fleet,
  incidents,
  cpu,
}: {
  fleet: unknown
  incidents: unknown
  cpu?: unknown
}) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => {
        if (url.startsWith('/fleet/cpu')) return cpu ?? emptyHistory('cpu')
        const chart = CHART_KINDS.find((kind) => url.startsWith(`/fleet/${kind}`))
        if (chart !== undefined) return emptyHistory(chart)
        return url.startsWith('/fleet') ? fleet : incidents
      },
    })),
  )

afterEach(() => {
  vi.restoreAllMocks()
  // the prefs store is a module singleton shared by every test in the file
  useFleetPrefsStore.setState({
    rangeMinutes: DEFAULT_RANGE_MINUTES,
    updateIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
    // the selected tab is persisted too, so a test that switched charts would
    // otherwise hand the next one a GPU panel
    chartKind: DEFAULT_CHART_KIND,
    chartExpanded: false,
  })
  localStorage.removeItem('wz-fleet-prefs')
})

test('Fleet grows the chart to its tall height on the toggle, and shrinks it back', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
    cpu: {
      kind: 'cpu',
      unit: 'percent',
      window_minutes: 60,
      hosts: [
        {
          name: 'vermithor',
          points: [
            { at: new Date(Date.now() - 60_000).toISOString(), value: 12.5 },
            { at: new Date(Date.now() - 30_000).toISOString(), value: 37.5 },
          ],
        },
      ],
    },
  })
  const { container } = renderFleet()
  await screen.findByRole('img', { name: /CPU by host over the last hour/ })

  // collapsed is the default: the short box keeps the host cards on screen
  expect(container.querySelector('.recharts-surface')).toHaveAttribute('height', '240')

  fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }))

  expect(container.querySelector('.recharts-surface')).toHaveAttribute('height', '600')
  expect(useFleetPrefsStore.getState().chartExpanded).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Collapse chart' }))

  expect(container.querySelector('.recharts-surface')).toHaveAttribute('height', '240')
})

test('HostCard names the host and its status in text, not by color alone', () => {
  render(<HostCard summary={{ ...summary, status: 'ok' }} />)

  expect(screen.getByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
  expect(screen.getByText('Healthy')).toBeInTheDocument()
})

// A warn host prints no status word at all: the finding is the disk and load
// figures the monitor judged, not a phrase summarising them over the name.
test('HostCard prints no status line on a warn host', () => {
  render(<HostCard summary={summary} />)

  expect(screen.getByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
  expect(screen.queryByText(/Needs attention/)).toBeNull()
  expect(screen.queryByText('Healthy')).toBeNull()
})

test('HostCard renders an uncollected host as unknown with no fabricated numbers', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'unknown',
        loadPerCore: null,
        memoryPercent: null,
        memoryTotalBytes: null,
        diskPercent: null,
        diskTotalBytes: null,
        uptimePercent: null,
        metricsStale: true,
        stalestFamily: null,
        stalestFamilyAgeSeconds: null,
        containers: [],
      }}
    />,
  )

  expect(screen.getByText('Not collected')).toBeInTheDocument()
  expect(screen.getByText(/No current readings for this host/)).toBeInTheDocument()
  expect(screen.queryByText('0%')).toBeNull()
  // the "oldest metric" note would be meaningless with no metrics at all
  expect(screen.queryByText(/Stale readings/)).toBeNull()
})

test('HostCard reports an unmeasured 24h uptime as unknown rather than a score', () => {
  render(<HostCard summary={{ ...summary, uptimePercent: null }} />)

  expect(screen.getByText('Unknown')).toBeInTheDocument()
  expect(screen.queryByText('100%')).toBeNull()
})

test('HostCard names the family that fell silent rather than blaming the slow tier', () => {
  // it used to print "Disk and temperature refresh every 15 minutes" whatever
  // had actually stopped, which read as a lie on meleys: both were seven
  // minutes old and a dead VPN counter was the stale reading
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'ok',
        metricsStale: true,
        stalestFamily: 'temp',
        stalestFamilyAgeSeconds: 604_800,
      }}
    />,
  )

  expect(screen.getByText(/temperature has not reported for 7 days/)).toBeInTheDocument()
  expect(screen.queryByText(/Disk and temperature refresh every 15 minutes/)).toBeNull()
})

// The monitor grows metrics faster than the label map does, and a family with
// no friendly name is still a truthful answer to what stopped reporting.
test('HostCard falls back to the raw family name it was not taught a word for', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'ok',
        metricsStale: true,
        stalestFamily: 'cpu2',
        stalestFamilyAgeSeconds: 3600,
      }}
    />,
  )

  expect(screen.getByText(/cpu2 has not reported for 1 hour/)).toBeInTheDocument()
})

test('HostCard says stale readings cannot be dated rather than "unknown old"', () => {
  // the monitor sends a null age when nothing reported inside its age window,
  // and when a clock step left a reading stamped ahead of now
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'ok',
        metricsStale: true,
        stalestFamily: null,
        stalestFamilyAgeSeconds: null,
      }}
    />,
  )

  expect(screen.getByText(/recently enough to date these values/)).toBeInTheDocument()
  expect(screen.queryByText(/unknown old/)).toBeNull()
})

// The status word is derived from disk, which is itself a slow-tier metric: on
// a host whose slow probe died it is as frozen as the numbers under it. The
// most prominent text on the card must not claim the present tense.
test('HostCard never presents an unqualified ok status when metrics are stale', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'ok',
        metricsStale: true,
        stalestFamily: 'disk',
        stalestFamilyAgeSeconds: 604_800,
      }}
    />,
  )

  expect(screen.queryByText('Healthy')).toBeNull()
  expect(screen.getByText('Healthy as of the last reading')).toBeInTheDocument()
})

test('HostCard leaves the status unqualified when every metric is fresh', () => {
  render(<HostCard summary={{ ...summary, status: 'ok', metricsStale: false }} />)

  expect(screen.getByText('Healthy')).toBeInTheDocument()
  expect(screen.queryByText(/as of the last reading/)).toBeNull()
})

test('HostCard omits the gpu row on a host with no render node', () => {
  render(<HostCard summary={{ ...summary, hasGpu: false }} />)

  expect(screen.queryByText('GPU')).toBeNull()
})

test('HostCard lists containers with their state in text', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        containers: [
          { name: 'sonarr', up: true, healthy: true, hasHealthcheck: true },
          { name: 'radarr', up: false, healthy: false, hasHealthcheck: false },
        ],
      }}
    />,
  )

  expect(screen.getByText('sonarr')).toBeInTheDocument()
  expect(screen.getByText('Up, healthy')).toBeInTheDocument()
  expect(screen.getByText('Down')).toBeInTheDocument()
})

test('HostCard claims no health for a container that declares no healthcheck', () => {
  // "no healthcheck configured" is neither a pass nor a failure: "Up, healthy"
  // asserts a check that never ran, "Up, unhealthy" asserts one that failed
  render(
    <HostCard
      summary={{
        ...summary,
        containers: [{ name: 'sabnzbd', up: true, healthy: false, hasHealthcheck: false }],
      }}
    />,
  )

  expect(screen.getByText('Up')).toBeInTheDocument()
  expect(screen.queryByText(/Up, /)).toBeNull()
})

test('HostCard names a failing healthcheck as unhealthy', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        containers: [{ name: 'plex', up: true, healthy: false, hasHealthcheck: true }],
      }}
    />,
  )

  expect(screen.getByText('Up, unhealthy')).toBeInTheDocument()
})

test('HostCard reads absent container data as not collected, never as no containers', () => {
  render(<HostCard summary={{ ...summary, containers: [] }} />)

  expect(screen.getByText(/Container data not collected/)).toBeInTheDocument()
})

test('HostCard omits the container section on a host with no docker', () => {
  render(<HostCard summary={{ ...summary, hasDocker: false, containers: [] }} />)

  expect(screen.queryByRole('heading', { name: 'Containers' })).toBeNull()
})

test('Fleet announces a dead collector separately from any host reading', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: true, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/collector/i)
})

test('Fleet renders one card per host once the payload lands', async () => {
  stubFleetFetch({
    fleet: {
      collected_at: '2026-08-15T00:00:00+00:00',
      stale: false,
      hosts: [
        host,
        {
          ...host,
          name: 'caraxes',
          ip: '192.168.50.4',
          collected: false,
          status: 'unknown',
          cores: null,
          load_per_core: null,
          memory_percent: null,
          memory_total_bytes: null,
          disk_percent: null,
          disk_total_bytes: null,
          containers: [],
          uptime_percent_24h: null,
        },
      ],
    },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  expect(await screen.findByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'caraxes' })).toBeInTheDocument()
  expect(screen.getByText('No open incidents.')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('Fleet shows a loading message while the first payload is in flight', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  renderFleet()

  expect(screen.getByText('Loading fleet status.')).toBeInTheDocument()
})

test('Fleet reports an unreachable monitor instead of an empty fleet', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
  renderFleet()

  expect(await screen.findByText(/No host state is available/)).toBeInTheDocument()
})

// requestJson composes a message naming the variable; collapsing every failure
// into one fixed string loses the only diagnostic the page has, and misreads a
// monitor that answered fine as one that could not be reached.
test('Fleet surfaces the configuration diagnostic rather than a fixed message', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=UTF-8' },
      json: async () => ({}),
    })),
  )
  renderFleet()

  // every query fails the same way, so scope the assertion to the host alert
  expect(
    await screen.findByText(/Expected JSON from \/fleet .*VITE_FLEET_BASE/),
  ).toBeInTheDocument()
})

test('Fleet says so when the monitor reports no hosts at all', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  // an empty list renders as nothing, which reads as a page still loading
  expect(await screen.findByText('The fleet monitor reported no hosts.')).toBeInTheDocument()
})

test('Fleet binds each card to the chart colour of the same host position', async () => {
  stubFleetFetch({
    fleet: {
      collected_at: '2026-08-15T00:00:00+00:00',
      stale: false,
      hosts: [host, { ...host, name: 'caraxes', ip: '192.168.50.4' }],
    },
    incidents: { open: [], recent: [] },
    cpu: {
      kind: 'cpu',
      unit: 'percent',
      window_minutes: 60,
      hosts: [
        { name: 'vermithor', points: [{ at: '2026-08-15T00:00:00+00:00', value: 12.5 }] },
        { name: 'caraxes', points: [] },
      ],
    },
  })
  renderFleet()

  const first = await screen.findByRole('heading', { name: 'vermithor' })
  const second = screen.getByRole('heading', { name: 'caraxes' })
  // both surfaces derive the class from array position, and the monitor
  // guarantees /fleet and /fleet/cpu agree on order
  expect(first.closest('article')).toHaveClass('series1')
  expect(second.closest('article')).toHaveClass('series2')
})

test('Fleet renders the selected chart in its tab panel once the payload lands', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
    cpu: {
      kind: 'cpu',
      unit: 'percent',
      window_minutes: 60,
      hosts: [
        {
          name: 'vermithor',
          // recent stamps: the chart's frame is the last hour ending now, and
          // readings outside it are not drawn
          points: [
            { at: new Date(Date.now() - 60_000).toISOString(), value: 12.5 },
            { at: new Date(Date.now() - 30_000).toISOString(), value: 37.5 },
          ],
        },
      ],
    },
  })
  renderFleet()

  expect(
    await screen.findByRole('img', { name: /CPU by host over the last hour/ }),
  ).toBeInTheDocument()
})

test('Fleet keeps the update-rate control reachable while the CPU query fails', async () => {
  // the slider tunes the polling the failing query does, so it must never
  // disappear behind the error it could help recover from
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
  renderFleet()

  expect(await screen.findByText(/No CPU history is available/)).toBeInTheDocument()
  expect(screen.getByLabelText('Update every')).toBeInTheDocument()
})

test('Fleet reports a failed CPU query without taking down the host cards', async () => {
  const cpuFailure = {
    ok: false,
    status: 502,
    headers: { get: () => 'application/json' },
    json: async () => ({}),
  }
  const good = (payload: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/fleet/cpu')) return cpuFailure
      if (url.startsWith('/fleet')) {
        return good({ collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] })
      }
      return good({ open: [], recent: [] })
    }),
  )
  renderFleet()

  expect(await screen.findByText(/No CPU history is available/)).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
})

test('Fleet lists open incidents by target and reason', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: {
      open: [
        {
          id: 1,
          target: 'host:caraxes',
          reason: 'timeout',
          opened_at: '2026-08-15T00:00:00+00:00',
          closed_at: null,
        },
      ],
      recent: [],
    },
  })
  renderFleet()

  expect(await screen.findByText('host:caraxes')).toBeInTheDocument()
  expect(screen.getByText('timeout')).toBeInTheDocument()
})

// The card carries a meter per capacity reading, so this one is found through
// its own label rather than by position: picking the first .meterFill on the
// card would silently start asserting against memory.
const meterUnder = (label: string): Element | null => {
  const cell = screen.getByText(label).parentElement
  return cell === null ? null : cell.querySelector('.meterFill')
}

test('HostCard draws the disk reading as a bar the number beside it already states', () => {
  const { container } = render(<HostCard summary={{ ...summary, diskPercent: 96 }} />)

  // the figure and its denominator are separate nodes so the number can carry
  // the weight and the qualifier can step back
  expect(screen.getByText('96%')).toBeInTheDocument()
  expect(screen.getByText('of 94.8 TB')).toBeInTheDocument()
  // the bar is a second reading of that one fact, so it stays out of the
  // accessibility tree rather than repeating the number there
  expect(meterUnder('Disk')).toHaveStyle({ width: '96%' })
  expect(container.querySelector('.meter')).toHaveAttribute('aria-hidden', 'true')
})

// The same treatment for both capacity readings: a percentage with a bar under
// it on one row and a bare percentage on the next reads as an accident.
test('HostCard draws the memory reading as a bar as well', () => {
  render(<HostCard summary={{ ...summary, memoryPercent: 29 }} />)

  expect(meterUnder('Memory')).toHaveStyle({ width: '29%' })
})

test('HostCard draws no disk bar where there is no disk reading', () => {
  // an absent reading is absent, not a bar sitting at zero
  render(<HostCard summary={{ ...summary, diskPercent: null, diskTotalBytes: null }} />)

  expect(meterUnder('Disk')).toBeNull()
})

// Load has no ceiling this card could honestly draw a bar against, and a full
// bar under every host's 100% uptime would carry no information at all.
test('HostCard draws no bar under the readings that have no scale', () => {
  render(<HostCard summary={summary} />)

  expect(meterUnder('Load / core')).toBeNull()
  expect(meterUnder('Uptime')).toBeNull()
})

// The tile beside a reading wears the host's chart colour, which the card
// border already states, and stands for the label beside it, which the label
// already states: it is a second reading of two facts, so it is hidden whole.
const tileBeside = (label: string): Element | null =>
  screen.getByText(label).parentElement?.querySelector('.tile') ?? null

test('HostCard sets a hidden tile in the host colour beside every reading', () => {
  render(<HostCard summary={summary} />)

  const tiles = ['Memory', 'Disk', 'Load / core', 'Uptime'].map(tileBeside)
  expect(tiles.map((tile) => tile?.getAttribute('aria-hidden'))).toEqual([
    'true',
    'true',
    'true',
    'true',
  ])
  expect(tiles.every((tile) => tile?.classList.contains('series') ?? false)).toBe(true)
})

test('HostCard marks a healthy status with a tile the word beside it already states', () => {
  render(<HostCard summary={{ ...summary, status: 'ok' }} />)

  const tile = screen.getByText('Healthy').closest('p')?.querySelector('.tile')
  expect(tile).toHaveAttribute('aria-hidden', 'true')
  expect(tile).toHaveClass('ok')
})

// Never collected is an absence, not a health: its tile must not borrow the
// healthy tone and let a reader's eye file the card as fine.
test('HostCard marks an uncollected status in the muted tone, not the healthy one', () => {
  render(<HostCard summary={{ ...summary, status: 'unknown' }} />)

  const tile = screen.getByText('Not collected').closest('p')?.querySelector('.tile')
  expect(tile).toHaveClass('muted')
  expect(tile).not.toHaveClass('ok')
})

test('HostCard leads each inventory row with a hidden tile and keeps the label in text', () => {
  render(<HostCard summary={summary} />)

  expect(tileBeside('GPU')).toHaveClass('muted')
  expect(tileBeside('GPU')).toHaveAttribute('aria-hidden', 'true')
  expect(tileBeside('Containers')).toHaveClass('muted')
  expect(screen.getByText('Intel iGPU present')).toBeInTheDocument()
})

test('Fleet asks the monitor for the chosen range, and marks it on the picker', async () => {
  // the picker's own suite covers the click reaching onChange; what this one
  // pins is the other half - a chosen range reaching the query, not the
  // hardcoded hour the page used to ask for
  // the slowest poll stop too, so the page's own refetch clock cannot fire
  // mid-test and make this about timing rather than about the range
  useFleetPrefsStore.setState({ rangeMinutes: 10_080, updateIntervalMs: 10_000 })
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  // the CPU query's own result, not the section heading: that heading renders
  // while all three queries are still in flight, so waiting on it waits for
  // nothing
  await screen.findByText(/No CPU readings in the last week/)
  // a week is the monitor's ceiling, so the lead-in minute every other range
  // asks for is clamped away here rather than refused
  expect(globalThis.fetch).toHaveBeenCalledWith('/fleet/cpu?minutes=10080', expect.anything())
  expect(screen.getByRole('button', { name: '1 week' })).toHaveAttribute('aria-pressed', 'true')
})

test('Fleet leaves the hard refresh off, since it polls on its own clock', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  await screen.findByRole('heading', { name: 'vermithor' })
  expect(screen.queryByRole('button', { name: 'Hard refresh' })).toBeNull()
})

test('Fleet offers one tab per chart and shows only the selected one', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()

  const tabs = await screen.findAllByRole('tab')
  expect(tabs.map((tab) => tab.textContent)).toEqual(['CPU', 'Memory', 'Network', 'GPU'])
  // exactly one selected, and exactly one panel: the chart nobody is looking at
  // is the chart whose query never runs
  expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(screen.getByText(/No CPU readings/)).toBeInTheDocument()
})

test('Fleet asks the monitor only for the chart the tab strip selects', async () => {
  useFleetPrefsStore.setState({ updateIntervalMs: 10_000 })
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()
  await screen.findByText(/No CPU readings/)

  // an hour drawn, an hour and a lead-in minute fetched
  expect(globalThis.fetch).toHaveBeenCalledWith('/fleet/cpu?minutes=61', expect.anything())
  expect(globalThis.fetch).not.toHaveBeenCalledWith('/fleet/gpu?minutes=61', expect.anything())

  fireEvent.click(screen.getByRole('tab', { name: 'GPU' }))

  await waitFor(() =>
    expect(globalThis.fetch).toHaveBeenCalledWith('/fleet/gpu?minutes=61', expect.anything()),
  )
  expect(screen.getByRole('tab', { name: 'GPU' })).toHaveAttribute('aria-selected', 'true')
})

// The ARIA tabs pattern: one tab stop for the strip, arrow keys within it.
test('Fleet moves between chart tabs with the arrow keys, wrapping at the ends', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
  })
  renderFleet()
  await screen.findAllByRole('tab')

  // keys land on the focused tab, the way they do in a browser: the strip
  // itself is not focusable in this pattern
  const selected = (): HTMLElement =>
    screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true') ??
    screen.getAllByRole('tab')[0]!

  fireEvent.keyDown(selected(), { key: 'ArrowRight' })
  expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true')

  fireEvent.keyDown(selected(), { key: 'ArrowLeft' })
  fireEvent.keyDown(selected(), { key: 'ArrowLeft' })
  // wrapped past the start onto the last tab
  expect(screen.getByRole('tab', { name: 'GPU' })).toHaveAttribute('aria-selected', 'true')

  fireEvent.keyDown(selected(), { key: 'Home' })
  expect(screen.getByRole('tab', { name: 'CPU' })).toHaveAttribute('aria-selected', 'true')
})

// Every kind and every range is its own query key, so most presses land on a
// payload that is not in cache. The panel used to empty for that moment, which
// dropped the chart's ~300px and jumped everything below it up the page.
const stubStalledChart = ({ stalled }: { stalled: string }) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith(`/fleet/${stalled}`)) return await new Promise(() => {})
      const chart = CHART_KINDS.find((kind) => url.startsWith(`/fleet/${kind}`))
      const json = async () => {
        if (chart !== undefined) return emptyHistory(chart)
        if (url.startsWith('/fleet'))
          return { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] }
        return { open: [], recent: [] }
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json }
    }),
  )

test('Fleet holds the chart shape while its first payload is in flight', async () => {
  stubStalledChart({ stalled: 'cpu' })
  renderFleet()

  // the caption is knowable before any reading is, so it stands in the same
  // words and the same space rather than being replaced by a one-line notice
  expect(
    await screen.findByText(/Aggregate CPU busy percent per host over the last hour/),
  ).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent(/Loading CPU readings for the last hour/)
  // the placeholder owns the loading state, so the section adds no second copy
  expect(screen.queryByText('Loading CPU history.')).toBeNull()
})

test('Fleet keeps the chart shape while an uncached tab loads', async () => {
  stubStalledChart({ stalled: 'gpu' })
  renderFleet()
  await screen.findByText(/No CPU readings/)

  fireEvent.click(screen.getByRole('tab', { name: 'GPU' }))

  expect(await screen.findByRole('status')).toHaveTextContent(/Loading GPU readings/)
  expect(
    screen.getByText(/Intel iGPU frequency as a share of its own ceiling, per host/),
  ).toBeInTheDocument()
})

// A spinner over a chart that already failed reads as a request still running,
// and the error beneath it as history. Only one of the two can be true.
test('Fleet drops the chart placeholder once the history request fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/fleet/cpu')) throw new Error('monitor down')
      const json = async () =>
        url.startsWith('/fleet')
          ? { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] }
          : { open: [], recent: [] }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json }
    }),
  )
  renderFleet()

  expect(await screen.findByText(/No CPU history is available/)).toBeInTheDocument()
  expect(screen.queryByText(/Loading CPU readings/)).toBeNull()
})
