import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import type { FleetHost, HostSummary } from '@/lib/fleetApi'
import { Fleet } from '@/pages/Fleet/Fleet'
import { HostCard } from '@/pages/Fleet/HostCard'
import { useAuthStore } from '@/stores/authStore'
import {
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
  oldestMetricAgeSeconds: 12,
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
  oldest_metric_age_seconds: 12,
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

const EMPTY_CPU = { window_minutes: 60, hosts: [] }

// All three queries go through the same window.fetch, so route the stub by
// path rather than by call order; /fleet/cpu must be tested before its /fleet
// prefix.
const stubFleetFetch = ({
  fleet,
  incidents,
  cpu = EMPTY_CPU,
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
        if (url.startsWith('/fleet/cpu')) return cpu
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
  })
  localStorage.removeItem('wz-fleet-prefs')
})

test('HostCard names the host and its status in text, not by color alone', () => {
  render(<HostCard summary={summary} />)

  expect(screen.getByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
  expect(screen.getByText('Needs attention')).toBeInTheDocument()
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
        oldestMetricAgeSeconds: null,
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

test('HostCard flags week-stale readings while the fast tier still reads fresh', () => {
  render(
    <HostCard
      summary={{ ...summary, status: 'ok', metricsStale: true, oldestMetricAgeSeconds: 604_800 }}
    />,
  )

  expect(screen.getByText(/Stale readings/)).toBeInTheDocument()
  expect(screen.getByText(/7 days old/)).toBeInTheDocument()
})

test('HostCard says stale readings cannot be dated rather than "unknown old"', () => {
  // the monitor sends a null age when nothing reported inside its age window,
  // and when a clock step left a reading stamped ahead of now
  render(
    <HostCard
      summary={{ ...summary, status: 'ok', metricsStale: true, oldestMetricAgeSeconds: null }}
    />,
  )

  expect(screen.getByText(/recently enough to date these values/)).toBeInTheDocument()
  expect(screen.queryByText(/unknown old/)).toBeNull()
})

// The status word is derived from disk, which is itself a slow-tier metric: on
// a host whose slow probe died it is as frozen as the numbers under it. The
// most prominent text on the card must not claim the present tense.
test.each([
  ['ok', 'Healthy'],
  ['warn', 'Needs attention'],
] as const)(
  'HostCard never presents an unqualified %s status when metrics are stale',
  (status, label) => {
    render(
      <HostCard
        summary={{ ...summary, status, metricsStale: true, oldestMetricAgeSeconds: 604_800 }}
      />,
    )

    expect(screen.queryByText(label)).toBeNull()
    expect(screen.getByText(`${label} as of the last reading`)).toBeInTheDocument()
  },
)

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

  // both queries fail the same way, so scope the assertion to the host alert
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
      window_minutes: 60,
      hosts: [
        { name: 'vermithor', points: [{ at: '2026-08-15T00:00:00+00:00', busy_percent: 12.5 }] },
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

test('Fleet renders the CPU section with its chart once the payload lands', async () => {
  stubFleetFetch({
    fleet: { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] },
    incidents: { open: [], recent: [] },
    cpu: {
      window_minutes: 60,
      hosts: [
        {
          name: 'vermithor',
          // recent stamps: the chart's frame is the last hour ending now, and
          // readings outside it are not drawn
          points: [
            { at: new Date(Date.now() - 60_000).toISOString(), busy_percent: 12.5 },
            { at: new Date(Date.now() - 30_000).toISOString(), busy_percent: 37.5 },
          ],
        },
      ],
    },
  })
  renderFleet()

  expect(await screen.findByRole('heading', { name: 'CPU' })).toBeInTheDocument()
  expect(screen.getByRole('slider', { name: 'Reading time' })).toBeInTheDocument()
  expect(screen.getByText('View as table')).toBeInTheDocument()
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

test('HostCard draws the disk reading as a bar the number beside it already states', () => {
  const { container } = render(<HostCard summary={{ ...summary, diskPercent: 96 }} />)

  expect(screen.getByText('96% of 94.8 TB')).toBeInTheDocument()
  // the bar is a second reading of that one fact, so it stays out of the
  // accessibility tree rather than repeating the number there
  const fill = container.querySelector('.gaugeFill')
  expect(fill).toHaveStyle({ width: '96%' })
  expect(container.querySelector('.gauge')).toHaveAttribute('aria-hidden', 'true')
})

test('HostCard draws no disk bar where there is no disk reading', () => {
  // an absent reading is absent, not a bar sitting at zero
  const { container } = render(
    <HostCard summary={{ ...summary, diskPercent: null, diskTotalBytes: null }} />,
  )

  expect(container.querySelector('.gauge')).toBeNull()
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
  // nothing. The stub echoes the monitor's window_minutes, so the prose here
  // names the stub's hour rather than the week that was asked for.
  await screen.findByText(/No CPU readings/)
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
