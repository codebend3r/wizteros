import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

export const DEFAULT_RANGE_DAYS = 365

export const DEFAULT_TAB: PlaysTab = 'overview'

const isRangeDays = (value: unknown): value is number =>
  typeof value === 'number' && PLAY_RANGES.some((range) => range.days === value)

const isTab = (value: unknown): value is PlaysTab => PLAYS_TABS.some((tab) => tab === value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type PlaysPrefsState = {
  readonly rangeDays: number
  readonly setRangeDays: (days: number) => void
  /** A config host name, or empty for every server. Validated as a string
      only: the host list is the monitor's to know, and arrives with the
      sync status rather than being pinned in this build. */
  readonly host: string
  readonly setHost: (host: string) => void
  readonly kind: KindFilter
  readonly setKind: (kind: KindFilter) => void
  readonly quality: QualityFilter
  readonly setQuality: (quality: QualityFilter) => void
  readonly tab: PlaysTab
  readonly setTab: (tab: PlaysTab) => void
}

/** The play history page's own knobs, persisted so a refresh keeps them.
 *
 * What comes back from storage is validated against the current lists, not
 * trusted: a range or a tab this build no longer offers, or a hand-edited
 * value, must fall back to the default rather than be sent to the monitor as
 * a filter it would refuse. */
export const usePlaysPrefsStore = create<PlaysPrefsState>()(
  persist(
    (set) => ({
      rangeDays: DEFAULT_RANGE_DAYS,
      setRangeDays: (days) => set({ rangeDays: isRangeDays(days) ? days : DEFAULT_RANGE_DAYS }),
      host: '',
      setHost: (host) => set({ host: typeof host === 'string' ? host : '' }),
      kind: '',
      setKind: (kind) => set({ kind: isKindFilter(kind) ? kind : '' }),
      quality: '',
      setQuality: (quality) => set({ quality: isQualityFilter(quality) ? quality : '' }),
      tab: DEFAULT_TAB,
      setTab: (tab) => set({ tab: isTab(tab) ? tab : DEFAULT_TAB }),
    }),
    {
      name: 'wz-plays-prefs',
      merge: (persisted, current) => {
        const stored = isRecord(persisted) ? persisted : {}
        return {
          ...current,
          rangeDays: isRangeDays(stored.rangeDays) ? stored.rangeDays : current.rangeDays,
          host: typeof stored.host === 'string' ? stored.host : current.host,
          kind: isKindFilter(stored.kind) ? stored.kind : current.kind,
          quality: isQualityFilter(stored.quality) ? stored.quality : current.quality,
          tab: isTab(stored.tab) ? stored.tab : current.tab,
        }
      },
    },
  ),
)

/** The store's four filters as the one object every read takes. */
export const selectFilters = (state: PlaysPrefsState): PlaysFilters => ({
  days: state.rangeDays,
  host: state.host,
  kind: state.kind,
  quality: state.quality,
})
