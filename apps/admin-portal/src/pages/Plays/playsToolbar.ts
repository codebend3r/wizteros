/** The words the play-history toolbar offers: which ranges, types and
    qualities a view can be narrowed to, and how a range reads in a sentence.
    Page copy, not wire contract, so it lives beside the page rather than in
    the module that talks to the monitor. */

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

/** The range a view opens on: a year, wide enough that a page opened cold
    says something, narrow enough not to ask the monitor for everything. Taken
    from the list rather than restated, so the default cannot name a range the
    toolbar does not offer. */
export const DEFAULT_PLAY_RANGE = PLAY_RANGES[3]

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
