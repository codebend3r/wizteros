import { afterEach, expect, test, vi } from '@/test/vi'
import {
  fetchFleet,
  fetchIncidents,
  type FleetHost,
  formatAge,
  formatBytes,
  memoryUsedPercent,
  toHostSummary,
} from '@/lib/fleetApi'

const host: FleetHost = {
  name: 'vermithor',
  ip: '192.168.50.3',
  has_gpu: true,
  has_docker: true,
  collected: true,
  metrics: { 'load.1m': 0.46 },
  metrics_stale: false,
  oldest_metric_age_seconds: 12,
  uptime_percent_24h: 100,
}

const JSON_HEADERS = { get: () => 'application/json' }

afterEach(() => {
  vi.restoreAllMocks()
})

test('memoryUsedPercent derives used percent from total and available', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 1000, 'mem.available_bytes': 250 })).toBe(75)
})

test('memoryUsedPercent returns null when either metric is missing', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 1000 })).toBeNull()
  expect(memoryUsedPercent({})).toBeNull()
})

test('memoryUsedPercent returns null on a zero total rather than dividing by zero', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 0, 'mem.available_bytes': 0 })).toBeNull()
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

test('toHostSummary marks an uncollected host as unknown rather than healthy', () => {
  const summary = toHostSummary({
    ...host,
    name: 'caraxes',
    ip: '192.168.50.4',
    has_gpu: false,
    has_docker: false,
    collected: false,
    metrics: {},
    metrics_stale: true,
    oldest_metric_age_seconds: null,
    uptime_percent_24h: null,
  })

  expect(summary.status).toBe('unknown')
  expect(summary.loadPerCore).toBeNull()
})

test('toHostSummary keeps a never-measured uptime null instead of a perfect score', () => {
  const summary = toHostSummary({ ...host, collected: false, uptime_percent_24h: null })

  expect(summary.uptimePercent).toBeNull()
})

test('toHostSummary normalizes load against four cores', () => {
  const summary = toHostSummary({
    ...host,
    name: 'meleys',
    ip: '192.168.50.2',
    has_gpu: false,
    metrics: { 'load.1m': 2 },
  })

  expect(summary.loadPerCore).toBe(0.5)
  expect(summary.status).toBe('ok')
})

test('toHostSummary flags a host whose disk is over the warn threshold', () => {
  const summary = toHostSummary({ ...host, metrics: { 'disk.volume1.used_percent': 99 } })

  expect(summary.status).toBe('warn')
})

test('toHostSummary carries per-metric staleness separately from the host status', () => {
  const summary = toHostSummary({
    ...host,
    metrics: { 'load.1m': 0.4, 'disk.volume1.used_percent': 42 },
    metrics_stale: true,
    oldest_metric_age_seconds: 604_800,
  })

  // The collector is alive and the fast tier is current, so the host is not
  // "down"; only the metric age exposes the week-dead slow tier behind it.
  expect(summary.status).toBe('ok')
  expect(summary.metricsStale).toBe(true)
  expect(summary.oldestMetricAgeSeconds).toBe(604_800)
})

test('toHostSummary reads containers out of the host metric keys', () => {
  const summary = toHostSummary({
    ...host,
    metrics: {
      'container.sonarr.up': 1,
      'container.sonarr.healthy': 1,
      'container.sonarr.has_healthcheck': 1,
      'container.plex.media.server.up': 1,
      'container.plex.media.server.healthy': 0,
      'container.plex.media.server.has_healthcheck': 1,
    },
  })

  expect(summary.containers).toEqual([
    { name: 'plex.media.server', up: true, healthy: false, hasHealthcheck: true },
    { name: 'sonarr', up: true, healthy: true, hasHealthcheck: true },
  ])
})

test('toHostSummary keeps a container with no healthcheck out of the health claim', () => {
  const summary = toHostSummary({
    ...host,
    metrics: {
      'container.sabnzbd.up': 1,
      'container.sabnzbd.healthy': 0,
      'container.sabnzbd.has_healthcheck': 0,
    },
  })

  expect(summary.containers).toEqual([
    { name: 'sabnzbd', up: true, healthy: false, hasHealthcheck: false },
  ])
})

test('toHostSummary leaves containers empty on a docker host that reported none', () => {
  const summary = toHostSummary({ ...host, metrics: { 'load.1m': 0.4 } })

  expect(summary.containers).toEqual([])
  expect(summary.hasDocker).toBe(true)
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
