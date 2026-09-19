import type { IconName } from '@/components/Icon/Icon'
import type { NeverPlayedKind, PlayKind, PlayQuality } from '@/lib/playsApi'
import type { PlaysTab } from '@/pages/Plays/playsParams'

/** The words one view needs that the other four do not. Everything the views
    say in common lives in the components; this is only what differs. */
export type TabCopy = {
  /** The tab's name and the section heading. */
  readonly title: string
  /** The glyph over the title on its tab. */
  readonly icon: IconName
  /** One sentence under the heading saying what the view counts. */
  readonly lede: string
  /** The noun in "No ... is available". */
  readonly reading: string
}

export const TAB_COPY: Record<PlaysTab, TabCopy> = {
  overview: {
    title: 'Overview',
    icon: 'pulse',
    lede: 'Completed plays across the fleet: when, what, at which quality, and on which server.',
    reading: 'overview',
  },
  viewers: {
    title: 'Viewers',
    icon: 'users',
    lede: 'Every account that completed a play, most active first. Pick one to read their history.',
    reading: 'viewer list',
  },
  top: {
    title: 'Most played',
    icon: 'play',
    lede: 'Titles ranked by completed plays. TV counts by show and audio by album.',
    reading: 'ranking',
  },
  rewatched: {
    title: 'Most rewatched',
    icon: 'refresh',
    lede: 'Titles a viewer completed more than once. Moving on to the next episode is not a rewatch.',
    reading: 'ranking',
  },
  never: {
    title: 'Never played',
    icon: 'unplayed',
    lede: 'What is on the shelves with no completed play against it, newest additions first.',
    reading: 'never-played list',
  },
}

export const KIND_LABEL: Record<PlayKind, string> = {
  movie: 'Movie',
  episode: 'TV',
  track: 'Audio',
}

/** The breakdown rows: plays are counted per item, so TV is episodes and
    audio is tracks here, not shows and albums. */
export const KIND_PLURAL: Record<PlayKind, string> = {
  movie: 'Movies',
  episode: 'Episodes',
  track: 'Tracks',
}

export const QUALITY_LABEL: Record<PlayQuality, string> = {
  '4k': '4K',
  '1080p': '1080p',
  '720p': '720p',
  other: 'Other',
}

export const NEVER_KIND_LABEL: Record<NeverPlayedKind, string> = {
  movie: 'Movie',
  show: 'Show',
  album: 'Album',
}

/** What "never played" means under the chosen window, stated where the list
    is, because the same rows read differently a year wide and all time wide. */
export const neverPlayedMeaning = ({ days, prose }: { days: number; prose: string }): string =>
  days === 0
    ? 'Never played, as far as Plex remembers.'
    : `No completed play in the last ${prose}. Widen the range to all time for what has never been played at all.`
