// The wire contract, as the portal checks it.
//
// These are the admin portal's own response types and runtime guards, copied
// from apps/admin-portal/src/lib/{guards,fleetApi,playsApi}.ts: a body that
// fails one of them is a page the portal refuses to draw. The route tests read
// every 200 through them, which both checks the contract and hands each test a
// typed body without a cast. Two additions the portal does not read: `metrics`
// on a host, which the Python tests assert on, and the /health body, which
// only the container healthcheck reads. If the portal's guards change, this
// copy changes with them.

type Guard<T> = (value: unknown) => value is T

// --- guards.ts ----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === 'number'

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isNumberMap = (value: unknown): value is Readonly<Record<string, number>> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'number')

const isListOf = <T>(value: unknown, is: Guard<T>): value is readonly T[] =>
  Array.isArray(value) && value.every(is)

// --- /health --------------------------------------------------------------------

export type Health = Readonly<{
  ok: boolean
  heartbeat_age_seconds: number | null
  stale: boolean
}>

export const isHealth = (value: unknown): value is Health =>
  isRecord(value) &&
  typeof value.ok === 'boolean' &&
  isNumberOrNull(value.heartbeat_age_seconds) &&
  typeof value.stale === 'boolean'

// --- fleetApi.ts ------------------------------------------------------------------

export type FleetContainer = Readonly<{
  name: string
  up: boolean
  healthy: boolean
  has_healthcheck: boolean
}>

export type FleetHost = Readonly<{
  name: string
  ip: string
  has_gpu: boolean
  has_docker: boolean
  collected: boolean
  status: 'ok' | 'warn' | 'unknown'
  cores: number | null
  load_per_core: number | null
  memory_percent: number | null
  memory_total_bytes: number | null
  disk_percent: number | null
  disk_total_bytes: number | null
  disk_available_bytes: number | null
  disk_mount: string
  containers: readonly FleetContainer[]
  metrics: Readonly<Record<string, number>>
  metrics_stale: boolean
  stalest_family: string | null
  stalest_family_age_seconds: number | null
  uptime_percent_24h: number | null
}>

export type FleetResponse = Readonly<{
  collected_at: string | null
  stale: boolean
  hosts: readonly FleetHost[]
}>

export type MetricPoint = Readonly<{ at: string; value: number }>

export type MetricHostSeries = Readonly<{ name: string; points: readonly MetricPoint[] }>

export type MetricHistory = Readonly<{
  kind: 'cpu' | 'memory' | 'gpu' | 'network'
  unit: 'percent' | 'bytes_per_second'
  window_minutes: number
  hosts: readonly MetricHostSeries[]
}>

export type Incident = Readonly<{
  id: number
  target: string
  reason: string
  opened_at: string
  closed_at: string | null
}>

export type IncidentFeed = Readonly<{ open: readonly Incident[]; recent: readonly Incident[] }>

const isHostStatus = (value: unknown): value is FleetHost['status'] =>
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
  isNumberOrNull(value.disk_available_bytes) &&
  typeof value.disk_mount === 'string' &&
  isListOf(value.containers, isFleetContainer) &&
  isNumberMap(value.metrics) &&
  typeof value.metrics_stale === 'boolean' &&
  isStringOrNull(value.stalest_family) &&
  isNumberOrNull(value.stalest_family_age_seconds) &&
  isNumberOrNull(value.uptime_percent_24h)

export const isFleetResponse = (value: unknown): value is FleetResponse =>
  isRecord(value) &&
  isStringOrNull(value.collected_at) &&
  typeof value.stale === 'boolean' &&
  isListOf(value.hosts, isFleetHost)

const isMetricKind = (value: unknown): value is MetricHistory['kind'] =>
  value === 'cpu' || value === 'memory' || value === 'gpu' || value === 'network'

const isMetricUnit = (value: unknown): value is MetricHistory['unit'] =>
  value === 'percent' || value === 'bytes_per_second'

const isMetricPoint = (value: unknown): value is MetricPoint =>
  isRecord(value) && typeof value.at === 'string' && typeof value.value === 'number'

const isMetricHostSeries = (value: unknown): value is MetricHostSeries =>
  isRecord(value) && typeof value.name === 'string' && isListOf(value.points, isMetricPoint)

export const isMetricHistory = (value: unknown): value is MetricHistory =>
  isRecord(value) &&
  isMetricKind(value.kind) &&
  isMetricUnit(value.unit) &&
  typeof value.window_minutes === 'number' &&
  isListOf(value.hosts, isMetricHostSeries)

const isIncident = (value: unknown): value is Incident =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.target === 'string' &&
  typeof value.reason === 'string' &&
  typeof value.opened_at === 'string' &&
  isStringOrNull(value.closed_at)

export const isIncidentFeed = (value: unknown): value is IncidentFeed =>
  isRecord(value) && isListOf(value.open, isIncident) && isListOf(value.recent, isIncident)

// --- playsApi.ts ------------------------------------------------------------------

type PlayKind = 'movie' | 'episode' | 'track'
type PlayQuality = '4k' | '1080p' | '720p' | 'other'

export type PlaysWindow = Readonly<{
  days: number
  since: string | null
  host: string | null
  kind: string | null
  quality: string | null
}>

export type TopViewer = Readonly<{ account_id: number; name: string; plays: number }>

export type TopTitle = Readonly<{
  key: string
  kind: PlayKind
  title: string
  context: string | null
  year: number | null
  quality: string | null
  plays: number
  viewers: number
  items: number
  rewatches: number
  top_rewatcher: TopViewer | null
  last_viewed_at: string
  hosts: readonly string[]
  thumb: string | null
}>

export type PlaysOverview = Readonly<{
  window: PlaysWindow
  totals: Readonly<{ plays: number; viewers: number; titles: number; watch_ms: number }>
  by_kind: readonly Readonly<{ kind: PlayKind; plays: number }>[]
  by_quality: readonly Readonly<{ quality: PlayQuality; plays: number }>[]
  by_host: readonly Readonly<{ host: string; friendly_name: string | null; plays: number }>[]
  timeline: Readonly<{
    bucket: 'day' | 'week' | 'month'
    points: readonly Readonly<{
      start: string
      plays: number
      hosts: Readonly<Record<string, number>>
    }>[]
  }>
  top_viewers: readonly TopViewer[]
  top_titles: readonly TopTitle[]
}>

export type PlayUser = Readonly<{
  account_id: number
  name: string
  thumb: string | null
  plays: number
  movies: number
  episodes: number
  tracks: number
  hosts: readonly string[]
  last_viewed_at: string | null
  top_title: string | null
}>

export type PlayUsers = Readonly<{ users: readonly PlayUser[] }>

export type ViewerHistoryRow = Readonly<{
  viewed_at: string
  host: string
  kind: PlayKind
  group_key: string
  title: string
  parent_title: string | null
  grandparent_title: string | null
  index: number | null
  parent_index: number | null
  year: number | null
  quality: string | null
  device: string | null
  library: string | null
  duration_ms: number | null
}>

export type ViewerHistory = Readonly<{
  account_id: number
  name: string
  total: number
  page: number
  page_size: number
  rows: readonly ViewerHistoryRow[]
}>

export type TopTitles = Readonly<{ metric: 'plays' | 'rewatches'; titles: readonly TopTitle[] }>

export type TitleHistoryRow = Readonly<{
  viewed_at: string
  host: string
  kind: PlayKind
  account_id: number
  viewer: string
  title: string
  index: number | null
  parent_index: number | null
  year: number | null
  quality: string | null
  device: string | null
  library: string | null
  duration_ms: number | null
}>

export type TitleHistory = Readonly<{
  key: string
  kind: PlayKind | null
  title: string
  context: string | null
  year: number | null
  quality: string | null
  viewers: number
  items: number
  rewatches: number
  first_viewed_at: string | null
  last_viewed_at: string | null
  hosts: readonly string[]
  total: number
  page: number
  page_size: number
  rows: readonly TitleHistoryRow[]
}>

export type NeverPlayedRow = Readonly<{
  key: string
  host: string
  kind: 'movie' | 'show' | 'album'
  title: string
  context: string | null
  year: number | null
  quality: string | null
  library: string | null
  added_at: string | null
  items: number
  thumb: string | null
}>

export type NeverPlayed = Readonly<{
  summary: Readonly<{
    movies: number
    shows: number
    albums: number
    by_quality: readonly Readonly<{ quality: string; count: number }>[]
    by_host: readonly Readonly<{ host: string; count: number }>[]
  }>
  total: number
  page: number
  page_size: number
  rows: readonly NeverPlayedRow[]
}>

export type PlaySyncServer = Readonly<{
  host: string
  friendly_name: string | null
  plex_url: string
  reachable: boolean
  history_synced_at: string | null
  library_synced_at: string | null
  history_since: string | null
  plays: number
  items: number
  last_error: string | null
}>

export type PlaySync = Readonly<{ lookback_days: number; servers: readonly PlaySyncServer[] }>

const isPlayKind = (value: unknown): value is PlayKind =>
  value === 'movie' || value === 'episode' || value === 'track'

const isPlayQuality = (value: unknown): value is PlayQuality =>
  value === '4k' || value === '1080p' || value === '720p' || value === 'other'

const isTopMetric = (value: unknown): value is TopTitles['metric'] =>
  value === 'plays' || value === 'rewatches'

const isTimelineBucket = (value: unknown): value is PlaysOverview['timeline']['bucket'] =>
  value === 'day' || value === 'week' || value === 'month'

const isNeverPlayedKind = (value: unknown): value is NeverPlayedRow['kind'] =>
  value === 'movie' || value === 'show' || value === 'album'

const isPlaysWindow = (value: unknown): value is PlaysWindow =>
  isRecord(value) &&
  typeof value.days === 'number' &&
  isStringOrNull(value.since) &&
  isStringOrNull(value.host) &&
  isStringOrNull(value.kind) &&
  isStringOrNull(value.quality)

const isPlaysTotals = (value: unknown): value is PlaysOverview['totals'] =>
  isRecord(value) &&
  typeof value.plays === 'number' &&
  typeof value.viewers === 'number' &&
  typeof value.titles === 'number' &&
  typeof value.watch_ms === 'number'

const isKindCount = (value: unknown): value is PlaysOverview['by_kind'][number] =>
  isRecord(value) && isPlayKind(value.kind) && typeof value.plays === 'number'

const isQualityCount = (value: unknown): value is PlaysOverview['by_quality'][number] =>
  isRecord(value) && isPlayQuality(value.quality) && typeof value.plays === 'number'

const isHostCount = (value: unknown): value is PlaysOverview['by_host'][number] =>
  isRecord(value) &&
  typeof value.host === 'string' &&
  isStringOrNull(value.friendly_name) &&
  typeof value.plays === 'number'

const isTimelinePoint = (value: unknown): value is PlaysOverview['timeline']['points'][number] =>
  isRecord(value) &&
  typeof value.start === 'string' &&
  typeof value.plays === 'number' &&
  isNumberMap(value.hosts)

const isTimeline = (value: unknown): value is PlaysOverview['timeline'] =>
  isRecord(value) && isTimelineBucket(value.bucket) && isListOf(value.points, isTimelinePoint)

const isTopViewer = (value: unknown): value is TopViewer =>
  isRecord(value) &&
  typeof value.account_id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.plays === 'number'

const isTopTitle = (value: unknown): value is TopTitle =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  isPlayKind(value.kind) &&
  typeof value.title === 'string' &&
  isStringOrNull(value.context) &&
  isNumberOrNull(value.year) &&
  isStringOrNull(value.quality) &&
  typeof value.plays === 'number' &&
  typeof value.viewers === 'number' &&
  typeof value.items === 'number' &&
  typeof value.rewatches === 'number' &&
  (value.top_rewatcher === null || isTopViewer(value.top_rewatcher)) &&
  typeof value.last_viewed_at === 'string' &&
  isStringArray(value.hosts) &&
  isStringOrNull(value.thumb)

export const isPlaysOverview = (value: unknown): value is PlaysOverview =>
  isRecord(value) &&
  isPlaysWindow(value.window) &&
  isPlaysTotals(value.totals) &&
  isListOf(value.by_kind, isKindCount) &&
  isListOf(value.by_quality, isQualityCount) &&
  isListOf(value.by_host, isHostCount) &&
  isTimeline(value.timeline) &&
  isListOf(value.top_viewers, isTopViewer) &&
  isListOf(value.top_titles, isTopTitle)

const isPlayUser = (value: unknown): value is PlayUser =>
  isRecord(value) &&
  typeof value.account_id === 'number' &&
  typeof value.name === 'string' &&
  isStringOrNull(value.thumb) &&
  typeof value.plays === 'number' &&
  typeof value.movies === 'number' &&
  typeof value.episodes === 'number' &&
  typeof value.tracks === 'number' &&
  isStringArray(value.hosts) &&
  isStringOrNull(value.last_viewed_at) &&
  isStringOrNull(value.top_title)

export const isPlayUsers = (value: unknown): value is PlayUsers =>
  isRecord(value) && isListOf(value.users, isPlayUser)

const isViewerHistoryRow = (value: unknown): value is ViewerHistoryRow =>
  isRecord(value) &&
  typeof value.viewed_at === 'string' &&
  typeof value.host === 'string' &&
  isPlayKind(value.kind) &&
  typeof value.group_key === 'string' &&
  typeof value.title === 'string' &&
  isStringOrNull(value.parent_title) &&
  isStringOrNull(value.grandparent_title) &&
  isNumberOrNull(value.index) &&
  isNumberOrNull(value.parent_index) &&
  isNumberOrNull(value.year) &&
  isStringOrNull(value.quality) &&
  isStringOrNull(value.device) &&
  isStringOrNull(value.library) &&
  isNumberOrNull(value.duration_ms)

export const isViewerHistory = (value: unknown): value is ViewerHistory =>
  isRecord(value) &&
  typeof value.account_id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.total === 'number' &&
  typeof value.page === 'number' &&
  typeof value.page_size === 'number' &&
  isListOf(value.rows, isViewerHistoryRow)

export const isTopTitles = (value: unknown): value is TopTitles =>
  isRecord(value) && isTopMetric(value.metric) && isListOf(value.titles, isTopTitle)

const isTitleHistoryRow = (value: unknown): value is TitleHistoryRow =>
  isRecord(value) &&
  typeof value.viewed_at === 'string' &&
  typeof value.host === 'string' &&
  isPlayKind(value.kind) &&
  typeof value.account_id === 'number' &&
  typeof value.viewer === 'string' &&
  typeof value.title === 'string' &&
  isNumberOrNull(value.index) &&
  isNumberOrNull(value.parent_index) &&
  isNumberOrNull(value.year) &&
  isStringOrNull(value.quality) &&
  isStringOrNull(value.device) &&
  isStringOrNull(value.library) &&
  isNumberOrNull(value.duration_ms)

export const isTitleHistory = (value: unknown): value is TitleHistory =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  (value.kind === null || isPlayKind(value.kind)) &&
  typeof value.title === 'string' &&
  isStringOrNull(value.context) &&
  isNumberOrNull(value.year) &&
  isStringOrNull(value.quality) &&
  typeof value.viewers === 'number' &&
  typeof value.items === 'number' &&
  typeof value.rewatches === 'number' &&
  isStringOrNull(value.first_viewed_at) &&
  isStringOrNull(value.last_viewed_at) &&
  isStringArray(value.hosts) &&
  typeof value.total === 'number' &&
  typeof value.page === 'number' &&
  typeof value.page_size === 'number' &&
  isListOf(value.rows, isTitleHistoryRow)

const isNeverPlayedSummary = (value: unknown): value is NeverPlayed['summary'] =>
  isRecord(value) &&
  typeof value.movies === 'number' &&
  typeof value.shows === 'number' &&
  typeof value.albums === 'number' &&
  isListOf(
    value.by_quality,
    (entry): entry is NeverPlayed['summary']['by_quality'][number] =>
      isRecord(entry) && typeof entry.quality === 'string' && typeof entry.count === 'number',
  ) &&
  isListOf(
    value.by_host,
    (entry): entry is NeverPlayed['summary']['by_host'][number] =>
      isRecord(entry) && typeof entry.host === 'string' && typeof entry.count === 'number',
  )

const isNeverPlayedRow = (value: unknown): value is NeverPlayedRow =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  typeof value.host === 'string' &&
  isNeverPlayedKind(value.kind) &&
  typeof value.title === 'string' &&
  isStringOrNull(value.context) &&
  isNumberOrNull(value.year) &&
  isStringOrNull(value.quality) &&
  isStringOrNull(value.library) &&
  isStringOrNull(value.added_at) &&
  typeof value.items === 'number' &&
  isStringOrNull(value.thumb)

export const isNeverPlayed = (value: unknown): value is NeverPlayed =>
  isRecord(value) &&
  isNeverPlayedSummary(value.summary) &&
  typeof value.total === 'number' &&
  typeof value.page === 'number' &&
  typeof value.page_size === 'number' &&
  isListOf(value.rows, isNeverPlayedRow)

const isPlaySyncServer = (value: unknown): value is PlaySyncServer =>
  isRecord(value) &&
  typeof value.host === 'string' &&
  isStringOrNull(value.friendly_name) &&
  typeof value.plex_url === 'string' &&
  typeof value.reachable === 'boolean' &&
  isStringOrNull(value.history_synced_at) &&
  isStringOrNull(value.library_synced_at) &&
  isStringOrNull(value.history_since) &&
  typeof value.plays === 'number' &&
  typeof value.items === 'number' &&
  isStringOrNull(value.last_error)

export const isPlaySync = (value: unknown): value is PlaySync =>
  isRecord(value) &&
  typeof value.lookback_days === 'number' &&
  isListOf(value.servers, isPlaySyncServer)

// --- reading a response -------------------------------------------------------

/** What `inject` answers with, as far as reading a body goes. */
export type Answer = Readonly<{ statusCode: number; body: string }>

/**
 * A 200's body, vouched for by the guard the portal reads it with. Anything
 * else fails the test with the body in the message, which is the fastest
 * route to what came back wrong.
 */
export const bodyOf = <T>({ answer, is }: { answer: Answer; is: Guard<T> }): T => {
  if (answer.statusCode !== 200) {
    throw new Error(`expected a 200 and got ${answer.statusCode}: ${answer.body}`)
  }
  const value: unknown = JSON.parse(answer.body)
  if (!is(value)) {
    throw new Error(`the portal would refuse this body: ${answer.body}`)
  }
  return value
}
