import {
  guardOf,
  type HostCount,
  type KindCount,
  type NeverPlayed,
  type NeverPlayedHostCount,
  type NeverPlayedKind,
  type NeverPlayedQualityCount,
  type NeverPlayedRow,
  neverPlayedSchema,
  type NeverPlayedSummary,
  type PlayHistory,
  type PlayHistoryRow,
  playHistorySchema,
  type PlayKind,
  playKindSchema,
  type PlayQuality,
  playQualitySchema,
  type PlaysOverview,
  playsOverviewSchema,
  type PlaysTotals,
  type PlaySync,
  playSyncSchema,
  type PlaySyncServer,
  type PlaysWindow,
  type PlayUser,
  type PlayUsers,
  playUsersSchema,
  type QualityCount,
  type Timeline,
  type TimelineBucket,
  type TimelinePoint,
  type TitleHistory,
  type TitleHistoryRow,
  titleHistorySchema,
  type TopMetric,
  topMetricSchema,
  type TopTitle,
  type TopTitles,
  topTitlesSchema,
  type TopViewer,
  type ViewerHistory,
  type ViewerHistoryRow,
  viewerHistorySchema,
} from '@wizteros/wire'
import { monitor } from '@/lib/fleetApi'

// The response types are the wire contract's, in libs/wire, where the monitor's
// own route tests check every body against the same schemas this module reads
// them with. The words the toolbar offers live with the page, in
// pages/Plays/playsToolbar.ts.
export type {
  HostCount,
  KindCount,
  NeverPlayed,
  NeverPlayedHostCount,
  NeverPlayedKind,
  NeverPlayedQualityCount,
  NeverPlayedRow,
  NeverPlayedSummary,
  PlayHistory,
  PlayHistoryRow,
  PlayKind,
  PlayQuality,
  PlaysOverview,
  PlaysTotals,
  PlaySync,
  PlaySyncServer,
  PlaysWindow,
  PlayUser,
  PlayUsers,
  QualityCount,
  Timeline,
  TimelineBucket,
  TimelinePoint,
  TitleHistory,
  TitleHistoryRow,
  TopMetric,
  TopTitle,
  TopTitles,
  TopViewer,
  ViewerHistory,
  ViewerHistoryRow,
}

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

export const isPlayKind = guardOf(playKindSchema)

export const isPlayQuality = guardOf(playQualitySchema)

export const isKindFilter = (value: unknown): value is KindFilter =>
  value === '' || isPlayKind(value)

export const isQualityFilter = (value: unknown): value is QualityFilter =>
  value === '' || isPlayQuality(value)

export const isTopMetric = guardOf(topMetricSchema)

const isPlaysOverview = guardOf(playsOverviewSchema)
const isPlayUsers = guardOf(playUsersSchema)
const isPlayHistory = guardOf(playHistorySchema)
const isViewerHistory = guardOf(viewerHistorySchema)
const isTopTitles = guardOf(topTitlesSchema)
const isTitleHistory = guardOf(titleHistorySchema)
const isNeverPlayed = guardOf(neverPlayedSchema)
const isPlaySync = guardOf(playSyncSchema)

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
  const optional: readonly [string, string][] = [
    ['host', host],
    ['kind', kind],
    ['quality', quality],
  ]
  return new URLSearchParams([
    ['days', String(days)],
    ...optional.filter(([, value]) => value.length > 0),
    ...Object.entries(extra).map(([name, value]): [string, string] => [name, String(value)]),
  ]).toString()
}

export const fetchPlaysOverview = ({
  filters,
}: {
  filters: PlaysFilters
}): Promise<PlaysOverview> =>
  monitor.read({
    path: `/plays/overview?${playsQuery(filters)}`,
    is: isPlaysOverview,
    what: 'play history overview',
  })

export const fetchPlayUsers = ({ filters }: { filters: PlaysFilters }): Promise<PlayUsers> =>
  monitor.read({
    path: `/plays/users?${playsQuery(filters)}`,
    is: isPlayUsers,
    what: 'viewers response',
  })

export const fetchPlayHistory = ({
  filters,
  page,
  pageSize,
}: {
  filters: PlaysFilters
  page: number
  pageSize: number
}): Promise<PlayHistory> =>
  monitor.read({
    path: `/plays/history?${playsQuery({ ...filters, extra: { page, page_size: pageSize } })}`,
    is: isPlayHistory,
    what: 'play history response',
  })

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
  const data = await monitor.read({
    path: `/plays/users/${accountId}/history?${query}`,
    is: isViewerHistory,
    what: 'viewer history response',
  })
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
  const data = await monitor.read({
    path: `/plays/top?${query}`,
    is: isTopTitles,
    what: 'top titles response',
  })
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
  const data = await monitor.read({
    path: `/plays/title?${query}`,
    is: isTitleHistory,
    what: 'title history response',
  })
  // A response for another title would print one film's plays under another's
  // name, silently and plausibly.
  if (data.key !== titleKey) {
    throw new Error(`Asked the fleet monitor for ${titleKey} and got ${data.key}`)
  }
  return data
}

export const fetchNeverPlayed = ({
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
  const extra: QueryExtra = { page, page_size: pageSize, ...(q.length > 0 ? { q } : {}) }
  return monitor.read({
    path: `/plays/never-played?${playsQuery({ ...filters, extra })}`,
    is: isNeverPlayed,
    what: 'never-played response',
  })
}

export const fetchPlaySync = (): Promise<PlaySync> =>
  monitor.read({ path: '/plays/sync', is: isPlaySync, what: 'sync status' })
