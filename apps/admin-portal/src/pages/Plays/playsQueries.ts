import type { PlaysFilters, TopMetric } from '@/lib/playsApi'

/** How often every play-history read polls. The collector re-reads each
    server every five minutes, so polling faster buys display latency, never
    extra data. */
export const REFETCH_MS = 300_000

/** Rows per page on the history and never-played tables. */
export const PAGE_SIZE = 50

/** Rows on a ranking. */
export const TOP_LIMIT = 25

// One builder per read, so the keys the page caches under and the keys a test
// asserts on cannot drift apart. Filters go in whole: TanStack hashes objects
// by content, so two equal filter sets share one cache entry whatever order
// their fields were built in.

export const SYNC_KEY = ['plays-sync'] as const

export const overviewKey = (filters: PlaysFilters) => ['plays-overview', filters] as const

export const usersKey = (filters: PlaysFilters) => ['plays-users', filters] as const

export const viewerKey = ({
  accountId,
  filters,
  page,
}: {
  accountId: number
  filters: PlaysFilters
  page: number
}) => ['plays-viewer', accountId, filters, page] as const

export const titleHistoryKey = ({
  key,
  filters,
  page,
}: {
  key: string
  filters: PlaysFilters
  page: number
}) => ['plays-title', key, filters, page] as const

export const topKey = ({ metric, filters }: { metric: TopMetric; filters: PlaysFilters }) =>
  ['plays-top', metric, filters] as const

export const neverKey = ({
  filters,
  page,
  q,
}: {
  filters: PlaysFilters
  page: number
  q: string
}) => ['plays-never', filters, page, q] as const
