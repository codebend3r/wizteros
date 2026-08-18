export type FleetMetrics = Readonly<Record<string, number>>

export type FleetHost = {
  readonly name: string
  readonly ip: string
  readonly has_gpu: boolean
  readonly has_docker: boolean
  readonly collected: boolean
  readonly metrics: FleetMetrics
  /** Derived from the metric timestamps, not the heartbeat: true when at least
      one reading on this host has outlived even its slowest refresh. */
  readonly metrics_stale: boolean
  readonly oldest_metric_age_seconds: number | null
  /** null when the host has never been collected: unknown, not a perfect score. */
  readonly uptime_percent_24h: number | null
}

export type FleetResponse = {
  readonly collected_at: string | null
  /** Collector liveness only. Says nothing about any individual metric. */
  readonly stale: boolean
  readonly hosts: readonly FleetHost[]
}

export type Incident = {
  readonly id: number
  readonly target: string
  readonly reason: string
  readonly opened_at: string
  readonly closed_at: string | null
}

export type IncidentFeed = {
  readonly open: readonly Incident[]
  readonly recent: readonly Incident[]
}

export type HostStatus = 'ok' | 'warn' | 'unknown'

export type ContainerSummary = {
  readonly name: string
  readonly up: boolean
  /** A healthcheck ran and passed. Meaningless unless `hasHealthcheck` is true. */
  readonly healthy: boolean
  /** Whether the container declares a healthcheck at all. Most on this fleet do
      not, and "no check configured" is neither a pass nor a failure. */
  readonly hasHealthcheck: boolean
}

export type HostSummary = {
  readonly name: string
  readonly ip: string
  readonly status: HostStatus
  readonly hasGpu: boolean
  readonly hasDocker: boolean
  readonly loadPerCore: number | null
  readonly memoryPercent: number | null
  readonly memoryTotalBytes: number | null
  readonly diskPercent: number | null
  readonly diskTotalBytes: number | null
  readonly uptimePercent: number | null
  readonly metricsStale: boolean
  readonly oldestMetricAgeSeconds: number | null
  readonly containers: readonly ContainerSummary[]
}

// Every box in the fleet is 4-core, measured 2026-08-10.
const CORES = 4
const DISK_WARN_PERCENT = 90
const LOAD_WARN_PER_CORE = 1

// The collector only ever runs `df -Pk /volume1`, so this is the one volume
// the monitor can report on.
const DISK_PERCENT_METRIC = 'disk.volume1.used_percent'
const DISK_TOTAL_METRIC = 'disk.volume1.total_bytes'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

const AGE_UNITS = [
  { seconds: 86_400, name: 'day' },
  { seconds: 3600, name: 'hour' },
  { seconds: 60, name: 'minute' },
] as const

const CONTAINER_METRIC = /^container\.(.+)\.(?:up|healthy|has_healthcheck)$/

export const formatBytes = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '--'
  // log2/10, not log(v)/log(1024): the latter comes back 2.9999999999999996 for
  // exactly 1024 ** 3, which floors to the wrong unit and renders "1024.0 MB"
  const index = Math.min(
    UNITS.length - 1,
    Math.max(0, Math.floor(Math.log2(Math.max(value, 1)) / 10)),
  )
  return `${(value / 1024 ** index).toFixed(1)} ${UNITS[index]}`
}

const plural = ({ count, unit }: { count: number; unit: string }): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`

/** A metric age in words. "unknown" for an absent age, because a host that was
    never measured has no age at all, and rendering it as 0 would read as fresh. */
export const formatAge = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const unit = AGE_UNITS.find((candidate) => seconds >= candidate.seconds)
  return unit
    ? plural({ count: Math.floor(seconds / unit.seconds), unit: unit.name })
    : 'less than a minute'
}

/** A metric's value, or null when the collector never recorded it. */
const metricValue = ({ metrics, key }: { metrics: FleetMetrics; key: string }): number | null =>
  typeof metrics[key] === 'number' ? metrics[key] : null

export const memoryUsedPercent = (metrics: FleetMetrics): number | null => {
  const total = metricValue({ metrics, key: 'mem.total_bytes' })
  const available = metricValue({ metrics, key: 'mem.available_bytes' })
  if (total === null || total <= 0 || available === null) return null
  return Math.round(((total - available) / total) * 100)
}

const containerNames = (metrics: FleetMetrics): readonly string[] =>
  [
    ...new Set(
      Object.keys(metrics).flatMap((key) => {
        const name = CONTAINER_METRIC.exec(key)?.[1] ?? ''
        return name ? [name] : []
      }),
    ),
  ].sort()

const toContainers = (metrics: FleetMetrics): readonly ContainerSummary[] =>
  containerNames(metrics).map((name) => ({
    name,
    up: metricValue({ metrics, key: `container.${name}.up` }) === 1,
    healthy: metricValue({ metrics, key: `container.${name}.healthy` }) === 1,
    hasHealthcheck: metricValue({ metrics, key: `container.${name}.has_healthcheck` }) === 1,
  }))

const hostStatus = ({
  collected,
  diskPercent,
  loadPerCore,
}: {
  collected: boolean
  diskPercent: number | null
  loadPerCore: number | null
}): HostStatus => {
  // "not collected" is its own state; it must never render as healthy
  if (!collected) return 'unknown'
  const overDisk = diskPercent !== null && diskPercent >= DISK_WARN_PERCENT
  const overLoad = loadPerCore !== null && loadPerCore >= LOAD_WARN_PER_CORE
  return overDisk || overLoad ? 'warn' : 'ok'
}

/** Flattens one `/fleet` host into what the card renders.
 *
 * Metric staleness stays a field of its own rather than folding into `status`:
 * a host whose fast tier is current but whose slow tier died a week ago is not
 * unhealthy, and calling it so would bury the one fact worth surfacing.
 */
export const toHostSummary = (host: FleetHost): HostSummary => {
  const load = host.collected ? metricValue({ metrics: host.metrics, key: 'load.1m' }) : null
  const diskPercent = host.collected
    ? metricValue({ metrics: host.metrics, key: DISK_PERCENT_METRIC })
    : null
  const loadPerCore = load === null ? null : load / CORES

  return {
    name: host.name,
    ip: host.ip,
    status: hostStatus({ collected: host.collected, diskPercent, loadPerCore }),
    hasGpu: host.has_gpu,
    hasDocker: host.has_docker,
    loadPerCore,
    memoryPercent: host.collected ? memoryUsedPercent(host.metrics) : null,
    memoryTotalBytes: host.collected
      ? metricValue({ metrics: host.metrics, key: 'mem.total_bytes' })
      : null,
    diskPercent,
    diskTotalBytes: host.collected
      ? metricValue({ metrics: host.metrics, key: DISK_TOTAL_METRIC })
      : null,
    uptimePercent: host.uptime_percent_24h,
    metricsStale: host.metrics_stale,
    oldestMetricAgeSeconds: host.oldest_metric_age_seconds,
    containers: host.collected ? toContainers(host.metrics) : [],
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === 'number'

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isMetrics = (value: unknown): value is FleetMetrics =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number')

const isFleetHost = (value: unknown): value is FleetHost =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.ip === 'string' &&
  typeof value.has_gpu === 'boolean' &&
  typeof value.has_docker === 'boolean' &&
  typeof value.collected === 'boolean' &&
  isMetrics(value.metrics) &&
  typeof value.metrics_stale === 'boolean' &&
  isNumberOrNull(value.oldest_metric_age_seconds) &&
  isNumberOrNull(value.uptime_percent_24h)

const isFleetResponse = (value: unknown): value is FleetResponse =>
  isRecord(value) &&
  isStringOrNull(value.collected_at) &&
  typeof value.stale === 'boolean' &&
  Array.isArray(value.hosts) &&
  value.hosts.every(isFleetHost)

const isIncident = (value: unknown): value is Incident =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.target === 'string' &&
  typeof value.reason === 'string' &&
  typeof value.opened_at === 'string' &&
  isStringOrNull(value.closed_at)

const isIncidentFeed = (value: unknown): value is IncidentFeed =>
  isRecord(value) &&
  Array.isArray(value.open) &&
  value.open.every(isIncident) &&
  Array.isArray(value.recent) &&
  value.recent.every(isIncident)

const FLEET_BASE: string = import.meta.env.VITE_FLEET_BASE ?? ''

// With VITE_FLEET_BASE unset the monitor call is relative, and /fleet is also
// this SPA's own route: the host answers it with index.html at 200. Name that
// instead of letting it surface later as an opaque JSON parse error.
const requestJson = async (path: string): Promise<unknown> => {
  const response = await fetch(`${FLEET_BASE}${path}`)
  if (!response.ok) throw new Error(`fleet request failed: ${response.status}`)
  const contentType = response.headers?.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    throw new Error(`Expected JSON from ${path} but got ${contentType}. Is VITE_FLEET_BASE set?`)
  }
  return await response.json()
}

export const fetchFleet = async (): Promise<FleetResponse> => {
  const data = await requestJson('/fleet')
  if (!isFleetResponse(data)) throw new Error('Unexpected fleet response from the fleet monitor')
  return data
}

export const fetchIncidents = async ({ hours }: { hours: number }): Promise<IncidentFeed> => {
  const data = await requestJson(`/incidents?hours=${hours}`)
  if (!isIncidentFeed(data)) {
    throw new Error('Unexpected incidents response from the fleet monitor')
  }
  return data
}
