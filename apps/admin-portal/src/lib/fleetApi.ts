import { supabase } from '@/lib/supabaseClient'

export type HostStatus = 'ok' | 'warn' | 'unknown'

/** One container as `/fleet` reports it. `healthy` is meaningless unless
    `has_healthcheck` is true: most containers on this fleet declare no
    healthcheck, which is neither a pass nor a failure. */
export type FleetContainer = {
  readonly name: string
  readonly up: boolean
  readonly healthy: boolean
  readonly has_healthcheck: boolean
}

/** One host as `/fleet` reports it.
 *
 * Every judgment here is made by the monitor, not by this page: which volume
 * is watched, how many cores the box turned out to have, what counts as too
 * full. The SPA used to re-derive all of it from the raw metric map, which put
 * fleet knowledge in a browser and a hardcoded core count in a constant.
 */
export type FleetHost = {
  readonly name: string
  readonly ip: string
  readonly has_gpu: boolean
  readonly has_docker: boolean
  readonly collected: boolean
  readonly status: HostStatus
  readonly cores: number | null
  readonly load_per_core: number | null
  readonly memory_percent: number | null
  readonly memory_total_bytes: number | null
  readonly disk_percent: number | null
  readonly disk_total_bytes: number | null
  readonly containers: readonly FleetContainer[]
  /** Derived from the metric timestamps, not the heartbeat: true when a whole
      metric family on this host has outlived even its slowest refresh. */
  readonly metrics_stale: boolean
  /** Which family fell silent (`disk`, `temp`, `net`, ...), so the card can
      name it rather than blame whichever probe is slowest in general. */
  readonly stalest_family: string | null
  readonly stalest_family_age_seconds: number | null
  /** null when the host has never been collected: unknown, not a perfect score. */
  readonly uptime_percent_24h: number | null
}

export type FleetResponse = {
  readonly collected_at: string | null
  /** Collector liveness only. Says nothing about any individual metric. */
  readonly stale: boolean
  readonly hosts: readonly FleetHost[]
}

/** Which history a response carries. One route each, one chart each, all four
    the same shape on the wire. */
export type MetricKind = 'cpu' | 'memory' | 'gpu' | 'network'

/** What the numbers mean. The chart cannot pick a y-axis without it: a percent
    runs against a fixed 0-100, a throughput against a ceiling derived from the
    readings themselves. */
export type MetricUnit = 'percent' | 'bytes_per_second'

/** One reading. A counter-derived value (CPU busy, throughput) is stamped at
    the later of the two readings it came from and describes the interval since
    the earlier one; a gauge-derived one (memory, GPU) is stamped when it was
    read. */
export type MetricPoint = {
  readonly at: string
  readonly value: number
}

/** One host's series. Empty when the host reported nothing in the window: not
    observed, never zero. Three of the five boxes have no render node at all,
    so on the GPU chart empty is the permanent and correct answer. */
export type MetricHostSeries = {
  readonly name: string
  readonly points: readonly MetricPoint[]
}

/** A history response. Hosts arrive in the same order as `/fleet`, guaranteed
    and tested server-side, which is what lets position bind a host to its
    colour on both the charts and the cards. */
export type MetricHistory = {
  readonly kind: MetricKind
  readonly unit: MetricUnit
  readonly window_minutes: number
  readonly hosts: readonly MetricHostSeries[]
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

export type ContainerSummary = {
  readonly name: string
  readonly up: boolean
  /** A healthcheck ran and passed. Meaningless unless `hasHealthcheck` is true. */
  readonly healthy: boolean
  /** Whether the container declares a healthcheck at all. */
  readonly hasHealthcheck: boolean
}

export type HostSummary = {
  readonly name: string
  readonly ip: string
  readonly status: HostStatus
  readonly hasGpu: boolean
  readonly hasDocker: boolean
  readonly cores: number | null
  readonly loadPerCore: number | null
  readonly memoryPercent: number | null
  readonly memoryTotalBytes: number | null
  readonly diskPercent: number | null
  readonly diskTotalBytes: number | null
  readonly uptimePercent: number | null
  readonly metricsStale: boolean
  readonly stalestFamily: string | null
  readonly stalestFamilyAgeSeconds: number | null
  readonly containers: readonly ContainerSummary[]
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

const AGE_UNITS = [
  { seconds: 86_400, name: 'day' },
  { seconds: 3600, name: 'hour' },
  { seconds: 60, name: 'minute' },
] as const

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

export const plural = ({ count, unit }: { count: number; unit: string }): string =>
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

/** Renames one `/fleet` host into what the card renders.
 *
 * Nothing is derived here any more, which is the point: the monitor decides
 * status, cores and usage, and this is only the wire-name to component-name
 * boundary. It used to gate five reads on `collected` while the server already
 * guaranteed those readings were absent in exactly that case.
 */
export const toHostSummary = (host: FleetHost): HostSummary => ({
  name: host.name,
  ip: host.ip,
  status: host.status,
  hasGpu: host.has_gpu,
  hasDocker: host.has_docker,
  cores: host.cores,
  loadPerCore: host.load_per_core,
  memoryPercent: host.memory_percent,
  memoryTotalBytes: host.memory_total_bytes,
  diskPercent: host.disk_percent,
  diskTotalBytes: host.disk_total_bytes,
  uptimePercent: host.uptime_percent_24h,
  metricsStale: host.metrics_stale,
  stalestFamily: host.stalest_family,
  stalestFamilyAgeSeconds: host.stalest_family_age_seconds,
  containers: host.containers.map((container) => ({
    name: container.name,
    up: container.up,
    healthy: container.healthy,
    hasHealthcheck: container.has_healthcheck,
  })),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === 'number'

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isHostStatus = (value: unknown): value is HostStatus =>
  value === 'ok' || value === 'warn' || value === 'unknown'

const isFleetContainer = (value: unknown): value is FleetContainer =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.up === 'boolean' &&
  typeof value.healthy === 'boolean' &&
  typeof value.has_healthcheck === 'boolean'

const isFleetHost = (value: unknown): value is FleetHost =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  typeof value.ip === 'string' &&
  typeof value.has_gpu === 'boolean' &&
  typeof value.has_docker === 'boolean' &&
  typeof value.collected === 'boolean' &&
  isHostStatus(value.status) &&
  isNumberOrNull(value.cores) &&
  isNumberOrNull(value.load_per_core) &&
  isNumberOrNull(value.memory_percent) &&
  isNumberOrNull(value.memory_total_bytes) &&
  isNumberOrNull(value.disk_percent) &&
  isNumberOrNull(value.disk_total_bytes) &&
  Array.isArray(value.containers) &&
  value.containers.every(isFleetContainer) &&
  typeof value.metrics_stale === 'boolean' &&
  isStringOrNull(value.stalest_family) &&
  isNumberOrNull(value.stalest_family_age_seconds) &&
  isNumberOrNull(value.uptime_percent_24h)

const isFleetResponse = (value: unknown): value is FleetResponse =>
  isRecord(value) &&
  isStringOrNull(value.collected_at) &&
  typeof value.stale === 'boolean' &&
  Array.isArray(value.hosts) &&
  value.hosts.every(isFleetHost)

const isMetricKind = (value: unknown): value is MetricKind =>
  value === 'cpu' || value === 'memory' || value === 'gpu' || value === 'network'

const isMetricUnit = (value: unknown): value is MetricUnit =>
  value === 'percent' || value === 'bytes_per_second'

const isMetricPoint = (value: unknown): value is MetricPoint =>
  isRecord(value) && typeof value.at === 'string' && typeof value.value === 'number'

const isMetricHostSeries = (value: unknown): value is MetricHostSeries =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  Array.isArray(value.points) &&
  value.points.every(isMetricPoint)

const isMetricHistory = (value: unknown): value is MetricHistory =>
  isRecord(value) &&
  isMetricKind(value.kind) &&
  isMetricUnit(value.unit) &&
  typeof value.window_minutes === 'number' &&
  Array.isArray(value.hosts) &&
  value.hosts.every(isMetricHostSeries)

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

// The monitor is reachable from the public internet now, so it authorizes
// every read off the Supabase session exactly as the bridge does: send the
// signed-in admin's access token as a bearer, read from the client per
// request so a refreshed session is picked up without a reload.
const authHeader = async (): Promise<Record<string, string>> => {
  if (!supabase) return {}
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// With VITE_FLEET_BASE unset the monitor call is relative, and /fleet is also
// this SPA's own route: the host answers it with index.html at 200. Name that
// instead of letting it surface later as an opaque JSON parse error.
const requestJson = async (path: string): Promise<unknown> => {
  const response = await fetch(`${FLEET_BASE}${path}`, { headers: await authHeader() })
  // The page renders behind AdminGate, so reaching here signed out means the
  // session lapsed mid-visit or this build points at a monitor that does not
  // allowlist the account - neither of which "fleet request failed: 401" says.
  if (response.status === 401) {
    throw new Error('Not signed in, or this account is not allowed to read the fleet.')
  }
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

/** One metric family's history. The kind is the route, so a new chart is a new
    kind on both sides rather than a second fetcher here. */
export const fetchMetricHistory = async ({
  kind,
  minutes,
}: {
  kind: MetricKind
  minutes: number
}): Promise<MetricHistory> => {
  const data = await requestJson(`/fleet/${kind}?minutes=${minutes}`)
  if (!isMetricHistory(data)) {
    throw new Error(`Unexpected ${kind} history response from the fleet monitor`)
  }
  // A response that answered for a different family would paint one chart with
  // another's numbers, silently and plausibly.
  if (data.kind !== kind) {
    throw new Error(`Asked the fleet monitor for ${kind} history and got ${data.kind}`)
  }
  return data
}

export const fetchIncidents = async ({ hours }: { hours: number }): Promise<IncidentFeed> => {
  const data = await requestJson(`/incidents?hours=${hours}`)
  if (!isIncidentFeed(data)) {
    throw new Error('Unexpected incidents response from the fleet monitor')
  }
  return data
}
