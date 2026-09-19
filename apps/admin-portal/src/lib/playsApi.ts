import { requestJson } from '@/lib/fleetApi'

/** The three things a completed play can be: the rule Plex's own ledger and
    Tautulli both keep. Anything else the server logged (a clip, a photo) never
    reaches this page. */
export type PlayKind = 'movie' | 'episode' | 'track'

/** The buckets video is grouped into. `other` folds SD and unknown together;
    audio has no quality at all and is left out of any quality breakdown. */
export type PlayQuality = '4k' | '1080p' | '720p' | 'other'

/** The two rankings the titles table can be sorted by. */
export type TopMetric = 'plays' | 'rewatches'

/** How the timeline was bucketed by the monitor, picked from the window. */
export type TimelineBucket = 'day' | 'week' | 'month'

/** What a never-played row stands for: movies are items, TV is grouped to
    the show, audio to the album. */
export type NeverPlayedKind = 'movie' | 'show' | 'album'

/** An empty string means "any", on both the type and the quality axis. */
export type KindFilter = PlayKind | ''
export type QualityFilter = PlayQuality | ''

/** Everything the page filters by, sent on every read. `days` of 0 is all
    time; an empty `host` is every server. */
export type PlaysFilters = {
  readonly days: number
  readonly host: string
  readonly kind: KindFilter
  readonly quality: QualityFilter
}

/** How far back a view looks, narrowest first, all time last. `prose` is the
    span as it reads mid-sentence, and `slug` is how the range is written in
    the address bar: `days=0` would read as no window at all, where `all` says
    what it means. */
export const PLAY_RANGES = [
  { days: 7, slug: '7d', label: '7 days', prose: '7 days' },
  { days: 30, slug: '30d', label: '30 days', prose: '30 days' },
  { days: 90, slug: '90d', label: '90 days', prose: '90 days' },
  { days: 365, slug: '1y', label: '1 year', prose: 'year' },
  { days: 0, slug: 'all', label: 'All time', prose: 'all time' },
] as const

export const PLAY_KINDS = [
  { kind: '', label: 'All types' },
  { kind: 'movie', label: 'Movies' },
  { kind: 'episode', label: 'TV' },
  { kind: 'track', label: 'Audio' },
] as const

export const PLAY_QUALITIES = [
  { quality: '', label: 'All' },
  { quality: '4k', label: '4K' },
  { quality: '1080p', label: '1080p' },
  { quality: '720p', label: '720p' },
  { quality: 'other', label: 'Other' },
] as const

/** A range as it reads mid-sentence. Falls back to the raw count for a value
    that is not a range, which only the store's guards should ever let through. */
export const rangeProse = (days: number): string =>
  PLAY_RANGES.find((range) => range.days === days)?.prose ?? `${days} days`

/** The window as a phrase: "over the last year", or "across all time". */
export const windowProse = (days: number): string =>
  days === 0 ? 'across all time' : `over the last ${rangeProse(days)}`

export const isPlayKind = (value: unknown): value is PlayKind =>
  value === 'movie' || value === 'episode' || value === 'track'

export const isPlayQuality = (value: unknown): value is PlayQuality =>
  value === '4k' || value === '1080p' || value === '720p' || value === 'other'

export const isKindFilter = (value: unknown): value is KindFilter =>
  value === '' || isPlayKind(value)

export const isQualityFilter = (value: unknown): value is QualityFilter =>
  value === '' || isPlayQuality(value)

export const isTopMetric = (value: unknown): value is TopMetric =>
  value === 'plays' || value === 'rewatches'

const isTimelineBucket = (value: unknown): value is TimelineBucket =>
  value === 'day' || value === 'week' || value === 'month'

const isNeverPlayedKind = (value: unknown): value is NeverPlayedKind =>
  value === 'movie' || value === 'show' || value === 'album'

/** The window the monitor actually answered for, echoed back so a response
    can never be mistaken for another filter's. */
export type PlaysWindow = {
  readonly days: number
  readonly since: string | null
  readonly host: string | null
  readonly kind: string | null
  readonly quality: string | null
}

export type PlaysTotals = {
  readonly plays: number
  readonly viewers: number
  readonly titles: number
  /** Summed item durations of every completed play, the closest thing a
      ledger of completions has to hours watched. */
  readonly watch_ms: number
}

export type KindCount = {
  readonly kind: PlayKind
  readonly plays: number
}

export type QualityCount = {
  readonly quality: PlayQuality
  readonly plays: number
}

/** One server's share. Hosts arrive in the monitor's config order, the same
    order `/fleet` uses, so position binds a server to its colour here too. */
export type HostCount = {
  readonly host: string
  readonly friendly_name: string | null
  readonly plays: number
}

export type TimelinePoint = {
  /** The bucket's first day as YYYY-MM-DD. */
  readonly start: string
  readonly plays: number
  /** Plays per host inside the bucket; a host with none is absent. */
  readonly hosts: Readonly<Record<string, number>>
}

export type Timeline = {
  readonly bucket: TimelineBucket
  readonly points: readonly TimelinePoint[]
}

export type TopViewer = {
  readonly account_id: number
  readonly name: string
  readonly plays: number
}

/** One ranked title. A movie is itself; TV is the show; audio is the album
    with the artist as `context`. `items` is how many distinct episodes or
    tracks were played, and `rewatches` counts the same viewer completing the
    same item again, never a viewer moving on to the next episode. */
export type TopTitle = {
  readonly key: string
  readonly kind: PlayKind
  readonly title: string
  readonly context: string | null
  readonly year: number | null
  readonly quality: string | null
  readonly plays: number
  readonly viewers: number
  readonly items: number
  readonly rewatches: number
  readonly top_rewatcher: TopViewer | null
  readonly last_viewed_at: string
  readonly hosts: readonly string[]
  readonly thumb: string | null
}

export type PlaysOverview = {
  readonly window: PlaysWindow
  readonly totals: PlaysTotals
  readonly by_kind: readonly KindCount[]
  readonly by_quality: readonly QualityCount[]
  readonly by_host: readonly HostCount[]
  readonly timeline: Timeline
  readonly top_viewers: readonly TopViewer[]
  readonly top_titles: readonly TopTitle[]
}

export type PlayUser = {
  readonly account_id: number
  readonly name: string
  readonly thumb: string | null
  readonly plays: number
  readonly movies: number
  readonly episodes: number
  readonly tracks: number
  readonly hosts: readonly string[]
  readonly last_viewed_at: string | null
  readonly top_title: string | null
}

export type PlayUsers = {
  readonly users: readonly PlayUser[]
}

export type ViewerHistoryRow = {
  readonly viewed_at: string
  readonly host: string
  readonly kind: string
  /** The title this play is ranked under, so the row can open that title's
      own history without the page rebuilding the key from the columns. */
  readonly group_key: string
  readonly title: string
  readonly parent_title: string | null
  readonly grandparent_title: string | null
  readonly index: number | null
  readonly parent_index: number | null
  readonly year: number | null
  readonly quality: string | null
  readonly device: string | null
  readonly library: string | null
  readonly duration_ms: number | null
}

export type ViewerHistory = {
  readonly account_id: number
  readonly name: string
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly rows: readonly ViewerHistoryRow[]
}

export type TopTitles = {
  readonly metric: TopMetric
  readonly titles: readonly TopTitle[]
}

/** One completion under a title, named by who finished it. `title` is the
    item, not the group: the episode, the track, the film. */
export type TitleHistoryRow = {
  readonly viewed_at: string
  readonly host: string
  readonly kind: string
  readonly account_id: number
  readonly viewer: string
  readonly title: string
  readonly index: number | null
  readonly parent_index: number | null
  readonly year: number | null
  readonly quality: string | null
  readonly device: string | null
  readonly library: string | null
  readonly duration_ms: number | null
}

/** Every completed play of one title, with the figures that scope them.
 *
 * `kind` is null and `title` empty only for a key nothing in the ledger
 * answers to, which is a link older than the library it names. The monitor
 * names the title from outside the window when the window holds no play, so
 * a narrowed filter leaves the page named rather than blank. */
export type TitleHistory = {
  readonly key: string
  readonly kind: PlayKind | null
  readonly title: string
  readonly context: string | null
  readonly year: number | null
  readonly quality: string | null
  readonly viewers: number
  readonly items: number
  readonly rewatches: number
  readonly first_viewed_at: string | null
  readonly last_viewed_at: string | null
  readonly hosts: readonly string[]
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly rows: readonly TitleHistoryRow[]
}

export type NeverPlayedQualityCount = {
  readonly quality: string
  readonly count: number
}

export type NeverPlayedHostCount = {
  readonly host: string
  readonly count: number
}

export type NeverPlayedSummary = {
  readonly movies: number
  readonly shows: number
  readonly albums: number
  /** Movies only: a show or an album has no single resolution. */
  readonly by_quality: readonly NeverPlayedQualityCount[]
  readonly by_host: readonly NeverPlayedHostCount[]
}

export type NeverPlayedRow = {
  readonly key: string
  readonly host: string
  readonly kind: NeverPlayedKind
  readonly title: string
  readonly context: string | null
  readonly year: number | null
  readonly quality: string | null
  readonly library: string | null
  readonly added_at: string | null
  /** Episodes in the show or tracks on the album; 1 for a movie. */
  readonly items: number
  readonly thumb: string | null
}

export type NeverPlayed = {
  readonly summary: NeverPlayedSummary
  readonly total: number
  readonly page: number
  readonly page_size: number
  readonly rows: readonly NeverPlayedRow[]
}

/** One server's sync state. `reachable` is the last history pass's outcome;
    `history_since` is the oldest play the ledger holds for it. */
export type PlaySyncServer = {
  readonly host: string
  readonly friendly_name: string | null
  readonly plex_url: string
  readonly reachable: boolean
  readonly history_synced_at: string | null
  readonly library_synced_at: string | null
  readonly history_since: string | null
  readonly plays: number
  readonly items: number
  readonly last_error: string | null
}

export type PlaySync = {
  readonly lookback_days: number
  readonly servers: readonly PlaySyncServer[]
}

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

const isPlaysWindow = (value: unknown): value is PlaysWindow =>
  isRecord(value) &&
  typeof value.days === 'number' &&
  isStringOrNull(value.since) &&
  isStringOrNull(value.host) &&
  isStringOrNull(value.kind) &&
  isStringOrNull(value.quality)

const isPlaysTotals = (value: unknown): value is PlaysTotals =>
  isRecord(value) &&
  typeof value.plays === 'number' &&
  typeof value.viewers === 'number' &&
  typeof value.titles === 'number' &&
  typeof value.watch_ms === 'number'

const isKindCount = (value: unknown): value is KindCount =>
  isRecord(value) && isPlayKind(value.kind) && typeof value.plays === 'number'

const isQualityCount = (value: unknown): value is QualityCount =>
  isRecord(value) && isPlayQuality(value.quality) && typeof value.plays === 'number'

const isHostCount = (value: unknown): value is HostCount =>
  isRecord(value) &&
  typeof value.host === 'string' &&
  isStringOrNull(value.friendly_name) &&
  typeof value.plays === 'number'

const isTimelinePoint = (value: unknown): value is TimelinePoint =>
  isRecord(value) &&
  typeof value.start === 'string' &&
  typeof value.plays === 'number' &&
  isNumberMap(value.hosts)

const isTimeline = (value: unknown): value is Timeline =>
  isRecord(value) &&
  isTimelineBucket(value.bucket) &&
  Array.isArray(value.points) &&
  value.points.every(isTimelinePoint)

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

const isPlaysOverview = (value: unknown): value is PlaysOverview =>
  isRecord(value) &&
  isPlaysWindow(value.window) &&
  isPlaysTotals(value.totals) &&
  Array.isArray(value.by_kind) &&
  value.by_kind.every(isKindCount) &&
  Array.isArray(value.by_quality) &&
  value.by_quality.every(isQualityCount) &&
  Array.isArray(value.by_host) &&
  value.by_host.every(isHostCount) &&
  isTimeline(value.timeline) &&
  Array.isArray(value.top_viewers) &&
  value.top_viewers.every(isTopViewer) &&
  Array.isArray(value.top_titles) &&
  value.top_titles.every(isTopTitle)

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

const isPlayUsers = (value: unknown): value is PlayUsers =>
  isRecord(value) && Array.isArray(value.users) && value.users.every(isPlayUser)

const isViewerHistoryRow = (value: unknown): value is ViewerHistoryRow =>
  isRecord(value) &&
  typeof value.viewed_at === 'string' &&
  typeof value.host === 'string' &&
  typeof value.kind === 'string' &&
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

const isViewerHistory = (value: unknown): value is ViewerHistory =>
  isRecord(value) &&
  typeof value.account_id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.total === 'number' &&
  typeof value.page === 'number' &&
  typeof value.page_size === 'number' &&
  Array.isArray(value.rows) &&
  value.rows.every(isViewerHistoryRow)

const isTopTitles = (value: unknown): value is TopTitles =>
  isRecord(value) &&
  isTopMetric(value.metric) &&
  Array.isArray(value.titles) &&
  value.titles.every(isTopTitle)

const isTitleHistoryRow = (value: unknown): value is TitleHistoryRow =>
  isRecord(value) &&
  typeof value.viewed_at === 'string' &&
  typeof value.host === 'string' &&
  typeof value.kind === 'string' &&
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

const isTitleHistory = (value: unknown): value is TitleHistory =>
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
  Array.isArray(value.rows) &&
  value.rows.every(isTitleHistoryRow)

const isNeverPlayedQualityCount = (value: unknown): value is NeverPlayedQualityCount =>
  isRecord(value) && typeof value.quality === 'string' && typeof value.count === 'number'

const isNeverPlayedHostCount = (value: unknown): value is NeverPlayedHostCount =>
  isRecord(value) && typeof value.host === 'string' && typeof value.count === 'number'

const isNeverPlayedSummary = (value: unknown): value is NeverPlayedSummary =>
  isRecord(value) &&
  typeof value.movies === 'number' &&
  typeof value.shows === 'number' &&
  typeof value.albums === 'number' &&
  Array.isArray(value.by_quality) &&
  value.by_quality.every(isNeverPlayedQualityCount) &&
  Array.isArray(value.by_host) &&
  value.by_host.every(isNeverPlayedHostCount)

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

const isNeverPlayed = (value: unknown): value is NeverPlayed =>
  isRecord(value) &&
  isNeverPlayedSummary(value.summary) &&
  typeof value.total === 'number' &&
  typeof value.page === 'number' &&
  typeof value.page_size === 'number' &&
  Array.isArray(value.rows) &&
  value.rows.every(isNeverPlayedRow)

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

const isPlaySync = (value: unknown): value is PlaySync =>
  isRecord(value) &&
  typeof value.lookback_days === 'number' &&
  Array.isArray(value.servers) &&
  value.servers.every(isPlaySyncServer)

/** Extra parameters a single read adds past the shared filters: a page, a
    metric, a search term. */
export type QueryExtra = Readonly<Record<string, string | number>>

/** The query string every play-history read sends.
 *
 * `days` always travels, because 0 is a value (all time) and not an absence.
 * The other three are omitted while empty rather than sent blank, so the
 * monitor never has to decide what an empty host means. Extras come last, in
 * the order given, so a page number reads after the filters it pages.
 */
export const playsQuery = ({
  days,
  host,
  kind,
  quality,
  extra = {},
}: PlaysFilters & { readonly extra?: QueryExtra }): string => {
  const params = new URLSearchParams({ days: String(days) })
  if (host.length > 0) params.set('host', host)
  if (kind.length > 0) params.set('kind', kind)
  if (quality.length > 0) params.set('quality', quality)
  Object.entries(extra).reduce((acc, [name, value]) => {
    acc.set(name, String(value))
    return acc
  }, params)
  return params.toString()
}

export const fetchPlaysOverview = async ({
  filters,
}: {
  filters: PlaysFilters
}): Promise<PlaysOverview> => {
  const data = await requestJson(`/plays/overview?${playsQuery(filters)}`)
  if (!isPlaysOverview(data)) {
    throw new Error('Unexpected play history overview from the fleet monitor')
  }
  return data
}

export const fetchPlayUsers = async ({
  filters,
}: {
  filters: PlaysFilters
}): Promise<PlayUsers> => {
  const data = await requestJson(`/plays/users?${playsQuery(filters)}`)
  if (!isPlayUsers(data)) throw new Error('Unexpected viewers response from the fleet monitor')
  return data
}

export const fetchViewerHistory = async ({
  filters,
  accountId,
  page,
  pageSize,
}: {
  filters: PlaysFilters
  accountId: number
  page: number
  pageSize: number
}): Promise<ViewerHistory> => {
  const query = playsQuery({ ...filters, extra: { page, page_size: pageSize } })
  const data = await requestJson(`/plays/users/${accountId}/history?${query}`)
  if (!isViewerHistory(data)) {
    throw new Error('Unexpected viewer history response from the fleet monitor')
  }
  // A response for another viewer would print one person's history under
  // another's name, silently and plausibly.
  if (data.account_id !== accountId) {
    throw new Error(`Asked the fleet monitor for viewer ${accountId} and got ${data.account_id}`)
  }
  return data
}

export const fetchTopTitles = async ({
  filters,
  metric,
  limit,
}: {
  filters: PlaysFilters
  metric: TopMetric
  limit: number
}): Promise<TopTitles> => {
  const query = playsQuery({ ...filters, extra: { metric, limit } })
  const data = await requestJson(`/plays/top?${query}`)
  if (!isTopTitles(data)) throw new Error('Unexpected top titles response from the fleet monitor')
  // A payload ranked by the other metric would fill "most rewatched" with the
  // most played, with nothing on the page to say so.
  if (data.metric !== metric) {
    throw new Error(`Asked the fleet monitor for titles by ${metric} and got ${data.metric}`)
  }
  return data
}

export const fetchTitleHistory = async ({
  filters,
  titleKey,
  page,
  pageSize,
}: {
  filters: PlaysFilters
  titleKey: string
  page: number
  pageSize: number
}): Promise<TitleHistory> => {
  const query = playsQuery({ ...filters, extra: { key: titleKey, page, page_size: pageSize } })
  const data = await requestJson(`/plays/title?${query}`)
  if (!isTitleHistory(data)) {
    throw new Error('Unexpected title history response from the fleet monitor')
  }
  // A response for another title would print one film's plays under another's
  // name, silently and plausibly.
  if (data.key !== titleKey) {
    throw new Error(`Asked the fleet monitor for ${titleKey} and got ${data.key}`)
  }
  return data
}

export const fetchNeverPlayed = async ({
  filters,
  page,
  pageSize,
  q,
}: {
  filters: PlaysFilters
  page: number
  pageSize: number
  q: string
}): Promise<NeverPlayed> => {
  const extra: QueryExtra =
    q.length > 0 ? { page, page_size: pageSize, q } : { page, page_size: pageSize }
  const data = await requestJson(`/plays/never-played?${playsQuery({ ...filters, extra })}`)
  if (!isNeverPlayed(data))
    throw new Error('Unexpected never-played response from the fleet monitor')
  return data
}

export const fetchPlaySync = async (): Promise<PlaySync> => {
  const data = await requestJson('/plays/sync')
  if (!isPlaySync(data)) throw new Error('Unexpected sync status from the fleet monitor')
  return data
}
