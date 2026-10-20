import { z } from 'zod'
import type { Wire } from './guard.js'

// The fleet monitor's play-history routes under /plays. Timestamps are
// Pydantic's ISO strings on the wire, as on the fleet routes.

const timestamp = z.string()

/** The three things a completed play can be: the rule Plex's own ledger and
    Tautulli both keep. Anything else the server logged (a clip, a photo)
    never reaches the page. */
export const playKindSchema = z.enum(['movie', 'episode', 'track'])

/** The buckets video is grouped into. `other` folds SD and unknown together;
    audio has no quality at all and is left out of any quality breakdown. */
export const playQualitySchema = z.enum(['4k', '1080p', '720p', 'other'])

/** The two rankings the titles table can be sorted by. */
export const topMetricSchema = z.enum(['plays', 'rewatches'])

/** How the timeline was bucketed by the monitor, picked from the window. */
export const timelineBucketSchema = z.enum(['day', 'week', 'month'])

/** What a never-played row stands for: movies are items, TV is grouped to
    the show, audio to the album. */
export const neverPlayedKindSchema = z.enum(['movie', 'show', 'album'])

/** The window the monitor actually answered for, echoed back so a response
    can never be mistaken for another filter's. */
export const playsWindowSchema = z.object({
  days: z.number(),
  since: timestamp.nullable(),
  host: z.string().nullable(),
  kind: z.string().nullable(),
  quality: z.string().nullable(),
})

export const playsTotalsSchema = z.object({
  plays: z.number(),
  viewers: z.number(),
  titles: z.number(),
  /** Summed item durations of every completed play, the closest thing a
      ledger of completions has to hours watched. */
  watch_ms: z.number(),
})

export const kindCountSchema = z.object({ kind: playKindSchema, plays: z.number() })

export const qualityCountSchema = z.object({ quality: playQualitySchema, plays: z.number() })

/** One server's share. Hosts arrive in the monitor's config order, the same
    order `/fleet` uses, so position binds a server to its colour here too. */
export const hostCountSchema = z.object({
  host: z.string(),
  friendly_name: z.string().nullable(),
  plays: z.number(),
})

export const timelinePointSchema = z.object({
  /** The bucket's first day as YYYY-MM-DD. */
  start: z.string(),
  plays: z.number(),
  /** Plays per host inside the bucket; a host with none is absent. */
  hosts: z.record(z.string(), z.number()),
})

export const timelineSchema = z.object({
  bucket: timelineBucketSchema,
  points: z.array(timelinePointSchema),
})

export const topViewerSchema = z.object({
  account_id: z.number(),
  name: z.string(),
  plays: z.number(),
})

/** One ranked title. A movie is itself; TV is the show; audio is the album
    with the artist as `context`. `items` is how many distinct episodes or
    tracks were played, and `rewatches` counts the same viewer completing the
    same item again, never a viewer moving on to the next episode. */
export const topTitleSchema = z.object({
  key: z.string(),
  kind: playKindSchema,
  title: z.string(),
  context: z.string().nullable(),
  year: z.number().nullable(),
  quality: z.string().nullable(),
  plays: z.number(),
  viewers: z.number(),
  items: z.number(),
  rewatches: z.number(),
  top_rewatcher: topViewerSchema.nullable(),
  last_viewed_at: timestamp,
  hosts: z.array(z.string()),
  thumb: z.string().nullable(),
})

export const playsOverviewSchema = z.object({
  window: playsWindowSchema,
  totals: playsTotalsSchema,
  by_kind: z.array(kindCountSchema),
  by_quality: z.array(qualityCountSchema),
  by_host: z.array(hostCountSchema),
  timeline: timelineSchema,
  top_viewers: z.array(topViewerSchema),
  top_titles: z.array(topTitleSchema),
})

export const playUserSchema = z.object({
  account_id: z.number(),
  name: z.string(),
  thumb: z.string().nullable(),
  plays: z.number(),
  movies: z.number(),
  episodes: z.number(),
  tracks: z.number(),
  hosts: z.array(z.string()),
  last_viewed_at: timestamp.nullable(),
  top_title: z.string().nullable(),
})

export const playUsersSchema = z.object({ users: z.array(playUserSchema) })

export const viewerHistoryRowSchema = z.object({
  viewed_at: timestamp,
  host: z.string(),
  kind: playKindSchema,
  /** The title this play is ranked under, so the row can open that title's
      own history without the page rebuilding the key from the columns. */
  group_key: z.string(),
  title: z.string(),
  parent_title: z.string().nullable(),
  grandparent_title: z.string().nullable(),
  index: z.number().nullable(),
  parent_index: z.number().nullable(),
  year: z.number().nullable(),
  quality: z.string().nullable(),
  device: z.string().nullable(),
  library: z.string().nullable(),
  duration_ms: z.number().nullable(),
})

export const viewerHistorySchema = z.object({
  account_id: z.number(),
  name: z.string(),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  rows: z.array(viewerHistoryRowSchema),
})

/** One completed play anywhere in the fleet: a viewer's row with who
    finished it beside it, since nothing around the table names anyone. */
export const playHistoryRowSchema = viewerHistoryRowSchema.extend({
  account_id: z.number(),
  viewer: z.string(),
})

/** Every completed play under the filters, newest first, a page at a time. */
export const playHistorySchema = z.object({
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  rows: z.array(playHistoryRowSchema),
})

export const topTitlesSchema = z.object({
  metric: topMetricSchema,
  titles: z.array(topTitleSchema),
})

/** One completion under a title, named by who finished it. `title` is the
    item, not the group: the episode, the track, the film. */
export const titleHistoryRowSchema = z.object({
  viewed_at: timestamp,
  host: z.string(),
  kind: playKindSchema,
  account_id: z.number(),
  viewer: z.string(),
  title: z.string(),
  index: z.number().nullable(),
  parent_index: z.number().nullable(),
  year: z.number().nullable(),
  quality: z.string().nullable(),
  device: z.string().nullable(),
  library: z.string().nullable(),
  duration_ms: z.number().nullable(),
})

/**
 * Every completed play of one title, with the figures that scope them.
 *
 * `kind` is null and `title` empty only for a key nothing in the ledger
 * answers to, which is a link older than the library it names. The monitor
 * names the title from outside the window when the window holds no play, so
 * a narrowed filter leaves the page named rather than blank.
 */
export const titleHistorySchema = z.object({
  key: z.string(),
  kind: playKindSchema.nullable(),
  title: z.string(),
  context: z.string().nullable(),
  year: z.number().nullable(),
  quality: z.string().nullable(),
  viewers: z.number(),
  items: z.number(),
  rewatches: z.number(),
  first_viewed_at: timestamp.nullable(),
  last_viewed_at: timestamp.nullable(),
  hosts: z.array(z.string()),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  rows: z.array(titleHistoryRowSchema),
})

export const neverPlayedQualityCountSchema = z.object({ quality: z.string(), count: z.number() })

export const neverPlayedHostCountSchema = z.object({ host: z.string(), count: z.number() })

export const neverPlayedSummarySchema = z.object({
  movies: z.number(),
  shows: z.number(),
  albums: z.number(),
  /** Movies only: a show or an album has no single resolution. */
  by_quality: z.array(neverPlayedQualityCountSchema),
  by_host: z.array(neverPlayedHostCountSchema),
})

export const neverPlayedRowSchema = z.object({
  key: z.string(),
  host: z.string(),
  kind: neverPlayedKindSchema,
  title: z.string(),
  context: z.string().nullable(),
  year: z.number().nullable(),
  quality: z.string().nullable(),
  library: z.string().nullable(),
  added_at: timestamp.nullable(),
  /** Episodes in the show or tracks on the album; 1 for a movie. */
  items: z.number(),
  thumb: z.string().nullable(),
})

export const neverPlayedSchema = z.object({
  summary: neverPlayedSummarySchema,
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  rows: z.array(neverPlayedRowSchema),
})

/** One server's sync state. `reachable` is the last history pass's outcome;
    `history_since` is the oldest play the ledger holds for it. */
export const playSyncServerSchema = z.object({
  host: z.string(),
  friendly_name: z.string().nullable(),
  plex_url: z.string(),
  reachable: z.boolean(),
  history_synced_at: timestamp.nullable(),
  library_synced_at: timestamp.nullable(),
  history_since: timestamp.nullable(),
  plays: z.number(),
  items: z.number(),
  last_error: z.string().nullable(),
})

export const playSyncSchema = z.object({
  lookback_days: z.number(),
  servers: z.array(playSyncServerSchema),
})

export type PlayKind = Wire<typeof playKindSchema>
export type PlayQuality = Wire<typeof playQualitySchema>
export type TopMetric = Wire<typeof topMetricSchema>
export type TimelineBucket = Wire<typeof timelineBucketSchema>
export type NeverPlayedKind = Wire<typeof neverPlayedKindSchema>
export type PlaysWindow = Wire<typeof playsWindowSchema>
export type PlaysTotals = Wire<typeof playsTotalsSchema>
export type KindCount = Wire<typeof kindCountSchema>
export type QualityCount = Wire<typeof qualityCountSchema>
export type HostCount = Wire<typeof hostCountSchema>
export type TimelinePoint = Wire<typeof timelinePointSchema>
export type Timeline = Wire<typeof timelineSchema>
export type TopViewer = Wire<typeof topViewerSchema>
export type TopTitle = Wire<typeof topTitleSchema>
export type PlaysOverview = Wire<typeof playsOverviewSchema>
export type PlayUser = Wire<typeof playUserSchema>
export type PlayUsers = Wire<typeof playUsersSchema>
export type ViewerHistoryRow = Wire<typeof viewerHistoryRowSchema>
export type ViewerHistory = Wire<typeof viewerHistorySchema>
export type PlayHistoryRow = Wire<typeof playHistoryRowSchema>
export type PlayHistory = Wire<typeof playHistorySchema>
export type TopTitles = Wire<typeof topTitlesSchema>
export type TitleHistoryRow = Wire<typeof titleHistoryRowSchema>
export type TitleHistory = Wire<typeof titleHistorySchema>
export type NeverPlayedQualityCount = Wire<typeof neverPlayedQualityCountSchema>
export type NeverPlayedHostCount = Wire<typeof neverPlayedHostCountSchema>
export type NeverPlayedSummary = Wire<typeof neverPlayedSummarySchema>
export type NeverPlayedRow = Wire<typeof neverPlayedRowSchema>
export type NeverPlayed = Wire<typeof neverPlayedSchema>
export type PlaySyncServer = Wire<typeof playSyncServerSchema>
export type PlaySync = Wire<typeof playSyncSchema>
