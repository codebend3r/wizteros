import { afterEach, expect, test, vi } from '@/test/vi'
import {
  fetchCpuHistory,
  fetchFleet,
  fetchIncidents,
  type FleetHost,
  formatAge,
  formatBytes,
  toHostSummary,
} from '@/lib/fleetApi'

// The monitor authorizes every read off the Supabase session now, so stub the
// client for authHeader() to draw a token from. Declared here rather than
// leaned on from adminApi.test.ts: bun's mock.module is process-global and
// leaks forward between files, which would leave these assertions passing only
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

// The monitor makes every judgment now: status, cores, usage and the container
// list all arrive decided. What used to be tested here - deriving memory
// percent, dividing load by a hardcoded four, comparing disk against a warn
// threshold, regex-parsing container names out of metric keys - moved to the
// side that owns those facts, and is tested there.
const host: FleetHost = {
  name: 'vermithor',
  ip: '192.168.50.3',
  has_gpu: true,
  has_docker: true,
  collected: true,
  status: 'ok',
  cores: 4,
  load_per_core: 0.115,
  memory_percent: 41,
  memory_total_bytes: 16_642_768_896,
  disk_percent: 62,
  disk_total_bytes: 8_000_000_000_000,
  containers: [{ name: 'sonarr', up: true, healthy: false, has_healthcheck: false }],
  metrics_stale: false,
  oldest_metric_age_seconds: 12,
  uptime_percent_24h: 100,
}

const JSON_HEADERS = { get: () => 'application/json' }

afterEach(() => {
  vi.restoreAllMocks()
})

test('formatBytes scales to the largest sensible unit', () => {
  expect(formatBytes(1_683_776 * 1024)).toBe('1.6 GB')
  expect(formatBytes(101_815_078_912 * 1024)).toBe('94.8 TB')
})

test('formatBytes crosses each unit exactly on the boundary', () => {
  // log(v)/log(1024) comes back 2.9999999999999996 for exactly 1024 ** 3 and
  // floors to the unit below, rendering a gibibyte as "1024.0 MB"
  expect(formatBytes(1024)).toBe('1.0 KB')
  expect(formatBytes(1024 ** 2)).toBe('1.0 MB')
  expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
  expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
  expect(formatBytes(1024 ** 5)).toBe('1.0 PB')
})

test('formatBytes renders a dash for a missing value', () => {
  expect(formatBytes(null)).toBe('--')
})

test('formatAge names the coarsest whole unit', () => {
  expect(formatAge(604_800)).toBe('7 days')
  expect(formatAge(86_400)).toBe('1 day')
  expect(formatAge(7200)).toBe('2 hours')
  expect(formatAge(90)).toBe('1 minute')
  expect(formatAge(5)).toBe('less than a minute')
})

test('formatAge reports an absent age as unknown rather than zero', () => {
  expect(formatAge(null)).toBe('unknown')
})

test('toHostSummary carries the status the monitor decided', () => {
  expect(toHostSummary({ ...host, status: 'unknown' }).status).toBe('unknown')
  expect(toHostSummary({ ...host, status: 'warn' }).status).toBe('warn')
})

test('toHostSummary keeps a never-measured uptime null instead of a perfect score', () => {
  expect(toHostSummary({ ...host, uptime_percent_24h: null }).uptimePercent).toBeNull()
})

test('toHostSummary carries per-metric staleness separately from the host status', () => {
  const summary = toHostSummary({ ...host, metrics_stale: true, oldest_metric_age_seconds: 7200 })

  // a host whose fast tier is current but whose slow tier died is not unhealthy
  expect(summary.status).toBe('ok')
  expect(summary.metricsStale).toBe(true)
  expect(summary.oldestMetricAgeSeconds).toBe(7200)
})

test('toHostSummary renames the container fields without reinterpreting them', () => {
  const summary = toHostSummary({
    ...host,
    containers: [
      { name: 'plex', up: true, healthy: true, has_healthcheck: true },
      { name: 'radarr', up: false, healthy: false, has_healthcheck: false },
    ],
  })

  expect(summary.containers).toEqual([
    { name: 'plex', up: true, healthy: true, hasHealthcheck: true },
    { name: 'radarr', up: false, healthy: false, hasHealthcheck: false },
  ])
})

test('toHostSummary passes an absent reading through as absent', () => {
  const summary = toHostSummary({
    ...host,
    cores: null,
    load_per_core: null,
    memory_percent: null,
    disk_percent: null,
    containers: [],
  })

  expect(summary.cores).toBeNull()
  expect(summary.loadPerCore).toBeNull()
  expect(summary.memoryPercent).toBeNull()
  expect(summary.diskPercent).toBeNull()
  expect(summary.containers).toEqual([])
})

test('fetchFleet requests /fleet and returns the validated payload', async () => {
  const payload = { collected_at: '2026-08-15T00:00:00+00:00', stale: false, hosts: [host] }
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, headers: JSON_HEADERS, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchFleet()).resolves.toEqual(payload)
  expect(fetchMock.mock.calls[0][0]).toBe('/fleet')
})

test('fetchFleet throws on a failed request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }),
  )

  await expect(fetchFleet()).rejects.toThrow('502')
})

test('fetchFleet rejects a payload that is not a fleet response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: JSON_HEADERS,
      json: async () => ({ hosts: 'nope' }),
    }),
  )

  await expect(fetchFleet()).rejects.toThrow('Unexpected fleet response')
})

// /fleet is also this SPA's own route, so an unset VITE_FLEET_BASE gets
// answered with index.html at 200 rather than a monitor payload.
test('fetchFleet names the HTML fallback instead of failing to parse it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=UTF-8' },
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    }),
  )

  await expect(fetchFleet()).rejects.toThrow('VITE_FLEET_BASE')
})

test('fetchCpuHistory asks for the requested window and returns the payload', async () => {
  const payload = {
    window_minutes: 60,
    hosts: [
      {
        name: 'meleys',
        points: [{ at: '2026-08-23T12:00:30+00:00', busy_percent: 12.5 }],
      },
      { name: 'caraxes', points: [] },
    ],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, headers: JSON_HEADERS, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchCpuHistory({ minutes: 60 })).resolves.toEqual(payload)
  expect(fetchMock.mock.calls[0][0]).toBe('/fleet/cpu?minutes=60')
})

test('fetchCpuHistory rejects a payload that is not a cpu history', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: JSON_HEADERS,
      json: async () => ({ window_minutes: 60, hosts: [{ name: 'meleys', points: [{}] }] }),
    }),
  )

  await expect(fetchCpuHistory({ minutes: 60 })).rejects.toThrow('Unexpected CPU history response')
})

test('fetchIncidents asks for the requested window and returns both lists', async () => {
  const payload = {
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
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, headers: JSON_HEADERS, json: async () => payload })
  vi.stubGlobal('fetch', fetchMock)

  await expect(fetchIncidents({ hours: 24 })).resolves.toEqual(payload)
  expect(fetchMock.mock.calls[0][0]).toBe('/incidents?hours=24')
})

test('fetchIncidents rejects a payload that is not an incident feed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: JSON_HEADERS,
      json: async () => ({ open: [{}] }),
    }),
  )

  await expect(fetchIncidents({ hours: 24 })).rejects.toThrow('Unexpected incidents response')
})

test('every monitor read carries the signed-in admin as a bearer', async () => {
  const ok = (json: unknown) => ({
    ok: true,
    status: 200,
    headers: JSON_HEADERS,
    json: async () => json,
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(ok({ collected_at: null, stale: false, hosts: [] }))
    .mockResolvedValueOnce(ok({ window_minutes: 60, hosts: [] }))
    .mockResolvedValueOnce(ok({ open: [], recent: [] }))
  vi.stubGlobal('fetch', fetchMock)

  await fetchFleet()
  await fetchCpuHistory({ minutes: 60 })
  await fetchIncidents({ hours: 24 })

  // Every route, not just the first: the monitor gates all three, so one
  // unauthenticated call is a section of the page that reads as down.
  const bearers = fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)
  expect(bearers).toEqual(['Bearer tok123', 'Bearer tok123', 'Bearer tok123'])
})

// The page renders behind AdminGate, so a 401 is a lapsed session or an
// account the monitor does not allowlist - not an unreachable monitor.
test('a rejected session is named rather than reported as a bare status', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: JSON_HEADERS,
      json: async () => ({}),
    }),
  )

  await expect(fetchCpuHistory({ minutes: 60 })).rejects.toThrow('not allowed to read the fleet')
})
