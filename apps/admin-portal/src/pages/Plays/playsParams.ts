import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  isKindFilter,
  isQualityFilter,
  PLAY_RANGES,
  type KindFilter,
  type PlaysFilters,
  type QualityFilter,
} from '@/lib/playsApi'

/** The five views, in the order the tab strip offers them. Overview leads
    because it is the summary; never played trails because it is the one
    view about absence. */
export const PLAYS_TABS = ['overview', 'viewers', 'top', 'rewatched', 'never'] as const

export type PlaysTab = (typeof PLAYS_TABS)[number]

export const DEFAULT_TAB: PlaysTab = 'overview'

export const DEFAULT_RANGE_DAYS = 365

/** Every knob on the page, by the name it takes in the query string.
 *
 * The address bar is the page's whole memory: anything that changes what is
 * on screen is written here, so a refresh, a bookmark or a pasted link all
 * land on the same view. Nothing is kept in storage beside it, because a
 * second memory could disagree with the url and win. */
export const PLAYS_PARAM = {
  tab: 'view',
  range: 'range',
  kind: 'type',
  quality: 'quality',
  host: 'server',
  viewer: 'user',
  title: 'title',
  page: 'page',
  search: 'q',
} as const

/** The whole page state, as one object read from the url. */
export type PlaysView = {
  readonly tab: PlaysTab
  readonly filters: PlaysFilters
  /** The viewer whose history is open, or null for the viewers table. */
  readonly viewer: number | null
  /** The title whose history is open, or null for the view behind it. A
      title can be opened from four of the five views, so it sits over
      whichever one is selected rather than belonging to one of them. */
  readonly title: string | null
  /** The page of whichever table the open view paginates, 1 based. */
  readonly page: number
  /** The never-played search term, empty for no search. */
  readonly search: string
}

const isTab = (value: unknown): value is PlaysTab => PLAYS_TABS.some((tab) => tab === value)

const daysFromSlug = (value: string | null): number =>
  PLAY_RANGES.find((range) => range.slug === value)?.days ?? DEFAULT_RANGE_DAYS

/** The slug for a range, so a url can be written from the days a filter
    press carries. Falls back to the default for a value that is not a range,
    which only a caller bypassing the toolbar could produce. */
export const rangeSlug = (days: number): string =>
  PLAY_RANGES.find((range) => range.days === days)?.slug ??
  PLAY_RANGES.find((range) => range.days === DEFAULT_RANGE_DAYS)?.slug ??
  'all'

const accountFromParam = (value: string | null): number | null => {
  if (value === null || value.length === 0) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

const titleFromParam = (value: string | null): string | null =>
  value === null || value.length === 0 ? null : value

const pageFromParam = (value: string | null): number => {
  if (value === null) return 1
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
}

/** The url as a view.
 *
 * Every value is checked against the lists this build offers rather than
 * trusted: a stale link, a hand-edited address or a range that has since been
 * dropped falls back to the default instead of reaching the monitor as a
 * filter it would refuse. A viewer named in the url is the view whatever the
 * tab says, so a link to someone's history always opens on it. */
export const readPlaysView = (params: URLSearchParams): PlaysView => {
  const viewer = accountFromParam(params.get(PLAYS_PARAM.viewer))
  const tabParam = params.get(PLAYS_PARAM.tab)
  const tab = isTab(tabParam) ? tabParam : DEFAULT_TAB
  const kind = params.get(PLAYS_PARAM.kind)
  const quality = params.get(PLAYS_PARAM.quality)
  return {
    tab: viewer === null ? tab : 'viewers',
    filters: {
      days: daysFromSlug(params.get(PLAYS_PARAM.range)),
      host: params.get(PLAYS_PARAM.host) ?? '',
      kind: isKindFilter(kind) ? kind : '',
      quality: isQualityFilter(quality) ? quality : '',
    },
    viewer,
    title: titleFromParam(params.get(PLAYS_PARAM.title)),
    page: pageFromParam(params.get(PLAYS_PARAM.page)),
    search: params.get(PLAYS_PARAM.search) ?? '',
  }
}

/** A view as the url that would read back as it.
 *
 * A default is written as an absent parameter rather than a spelled-out one,
 * so the address stays short and `/plays` and `/plays?view=overview&range=1y`
 * are the same page. Parameters this page does not own are carried through
 * untouched. */
export const writePlaysView = ({
  params,
  view,
}: {
  params: URLSearchParams
  view: PlaysView
}): URLSearchParams => {
  const next = new URLSearchParams(params)
  const put = (name: string, value: string, fallback: string) => {
    if (value === fallback) {
      next.delete(name)
      return
    }
    next.set(name, value)
  }
  put(PLAYS_PARAM.tab, view.tab, DEFAULT_TAB)
  put(PLAYS_PARAM.range, rangeSlug(view.filters.days), rangeSlug(DEFAULT_RANGE_DAYS))
  put(PLAYS_PARAM.kind, view.filters.kind, '')
  put(PLAYS_PARAM.quality, view.filters.quality, '')
  put(PLAYS_PARAM.host, view.filters.host, '')
  put(PLAYS_PARAM.viewer, view.viewer === null ? '' : String(view.viewer), '')
  put(PLAYS_PARAM.title, view.title ?? '', '')
  put(PLAYS_PARAM.page, String(view.page), '1')
  put(PLAYS_PARAM.search, view.search, '')
  return next
}

type PlaysParams = PlaysView & {
  readonly setRangeDays: (days: number) => void
  readonly setKind: (kind: KindFilter) => void
  readonly setQuality: (quality: QualityFilter) => void
  readonly setHost: (host: string) => void
  readonly setTab: (tab: PlaysTab) => void
  readonly openViewer: (accountId: number) => void
  readonly closeViewer: () => void
  readonly openTitle: (key: string) => void
  readonly closeTitle: () => void
  readonly setPage: (page: number) => void
  readonly setSearch: (search: string) => void
}

/** The play history page's knobs, held in the query string.
 *
 * Reads come from the url alone, so the back button, a refresh and a pasted
 * link all produce the same view with no state to reconcile. Every change but
 * paging drops the page number, because page four of the old list is not a
 * page of the new one, and leaving a view drops what only that view uses. */
export const usePlaysParams = (): PlaysParams => {
  const [searchParams, setSearchParams] = useSearchParams()
  // one object per distinct query string, so every query key and every panel
  // sees the same identity and a repaint does not refetch
  const view = useMemo(() => readPlaysView(searchParams), [searchParams])

  // push, not replace: every knob is a place the admin was, so the back
  // button walks them in reverse, a range press and a title opened alike.
  // A press that changes nothing (the range already selected, the tab
  // already open) writes no entry, or the back button would appear to do
  // nothing on the way through it.
  const apply = (next: PlaysView) => {
    const written = writePlaysView({ params: searchParams, view: next })
    if (written.toString() === searchParams.toString()) return
    setSearchParams(written)
  }

  const reset = (next: Partial<PlaysView>): PlaysView => ({ ...view, ...next, page: 1 })
  const setFilters = (filters: Partial<PlaysFilters>) =>
    apply(reset({ filters: { ...view.filters, ...filters } }))

  return {
    ...view,
    setRangeDays: (days) => setFilters({ days }),
    setKind: (kind) => setFilters({ kind }),
    setQuality: (quality) => setFilters({ quality }),
    setHost: (host) => setFilters({ host }),
    // the search belongs to the never-played view and the viewer to the
    // viewers view, so neither outlives the tab it was set on
    setTab: (tab) => apply(reset({ tab, viewer: null, title: null, search: '' })),
    openViewer: (accountId) => apply(reset({ tab: 'viewers', viewer: accountId, title: null })),
    closeViewer: () => apply(reset({ tab: 'viewers', viewer: null, title: null })),
    // a title sits over the view it was opened from, so closing it drops
    // only the title and lands back on that view, viewer and all
    openTitle: (key) => apply(reset({ title: key })),
    closeTitle: () => apply(reset({ title: null })),
    setPage: (page) => apply({ ...view, page }),
    setSearch: (search) => apply(reset({ search })),
  }
}
