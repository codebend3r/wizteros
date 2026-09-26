import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import { httpError, SupabaseAdminGuard } from '@wizteros/server-common'
import { z } from 'zod'
import { intQuery, textQuery } from '@/api/validation.js'
import { dbPath, plexHosts, plexLookbackDays } from '@/config.js'
import { session } from '@/db.js'
import * as plays from '@/plays/index.js'
import { addSeconds, epochSeconds } from '@/time.js'

// Play history. Like every other route, each of these opens one session for
// its whole response, in `read` mode: the temp table a view builds lives in
// that connection only, and nothing here writes the main database.

// The query literals are the store's own (`KIND_ORDER`, `QUALITY_FILTERS`,
// `Metric`) rather than copies declared here: a copy that drifts turns a valid
// filter into a 422 the page cannot explain. `Metric` is only a type in the
// store, so its list is written here and checked against it.
const METRICS = ['plays', 'rewatches'] as const satisfies readonly plays.Metric[]

// A year by default, the same span the first backfill reaches; zero means all
// time. The ceiling is generous but bounded for the same reason as
// MAX_INCIDENT_HOURS: an absurd value has to be a client error, not a 500 from
// a date that overflowed.
export const DEFAULT_PLAY_DAYS = 365
export const MAX_PLAY_DAYS = 365 * 10
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
export const DEFAULT_TOP_LIMIT = 25
export const MAX_TOP_LIMIT = 100
export const MAX_SEARCH_LENGTH = 200
// A group key is `kind:title:year` over titles the library holds, so a
// generous bound still refuses anything that cannot be one.
export const MAX_KEY_LENGTH = 500

const DAY_SECONDS = 86_400

/**
 * The window an answer covers, echoed back so a response can never be
 * mistaken for another filter's. `since` is null for all time.
 */
export type PlaysWindow = Readonly<{
  days: number
  since: Date | null
  host: string | null
  kind: string | null
  quality: string | null
}>

/**
 * The four filters every play-history read takes, resolved once. `now` is
 * read here so the window, the timeline bucket and every "ago" on the page
 * are measured from the same instant.
 */
export type PlayQuery = Readonly<{
  days: number
  filters: plays.Filters
  now: Date
}>

/** The window a resolved query answers for: the `window` property of the dataclass. */
export const playsWindow = ({ days, filters }: PlayQuery): PlaysWindow => ({
  days,
  since: filters.since === null ? null : new Date(filters.since * 1000),
  host: filters.host,
  kind: filters.kind,
  quality: filters.quality,
})

// Every view below carries the store's arrays as they are. FastAPI serialized
// a tuple as a JSON array, so copying each one changed nothing on the wire
// and made a pass-through read like a transformation.

/** `plays.Overview` plus the window it answers for. */
export type PlaysOverviewView = Readonly<{
  window: PlaysWindow
  totals: plays.Totals
  by_kind: readonly plays.KindCount[]
  by_quality: readonly plays.QualityCount[]
  by_host: readonly plays.HostCount[]
  timeline: plays.Timeline
  top_viewers: readonly plays.Viewer[]
  top_titles: readonly plays.TopTitle[]
}>

export type PlayUsersView = Readonly<{
  users: readonly plays.User[]
}>

/**
 * `metric` travels with the rows so the page cannot fill its rewatched table
 * with the most played, silently and plausibly.
 */
export type TopTitlesView = Readonly<{
  metric: plays.Metric
  titles: readonly plays.TopTitle[]
}>

export type PlaySyncView = Readonly<{
  lookback_days: number
  servers: readonly plays.ServerStatus[]
}>

// The shared filters, then each route's own parameters beside them.
const FILTERS = {
  days: intQuery({ fallback: DEFAULT_PLAY_DAYS, min: 0, max: MAX_PLAY_DAYS }),
  host: z.string().optional(),
  kind: z.enum(plays.KIND_ORDER).optional(),
  quality: z.enum(plays.QUALITY_FILTERS).optional(),
}

const PAGING = {
  page: intQuery({ fallback: 1, min: 1 }),
  page_size: intQuery({ fallback: DEFAULT_PAGE_SIZE, min: 1, max: MAX_PAGE_SIZE }),
}

const FilterQuery = z.object(FILTERS)

const PagedQuery = z.object({ ...FILTERS, ...PAGING })

const TitleQuery = z.object({
  ...FILTERS,
  key: textQuery({ min: 1, max: MAX_KEY_LENGTH }),
  ...PAGING,
})

const TopQuery = z.object({
  ...FILTERS,
  metric: z.enum(METRICS).default('plays'),
  limit: intQuery({ fallback: DEFAULT_TOP_LIMIT, min: 1, max: MAX_TOP_LIMIT }),
})

const NeverPlayedQuery = z.object({
  ...FILTERS,
  ...PAGING,
  q: textQuery({ max: MAX_SEARCH_LENGTH }).default(''),
})

const AccountId = intQuery({})

// Python's `repr()` of a str, which is how the Python API quoted a host it did
// not know: single quotes, unless the text holds one and no double quote, and
// every character `str.isprintable()` refuses written as an escape.
const NAMED_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\r', '\\r'],
])

// What `str.isprintable()` is false for, the ASCII space excepted.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

const hex = ({ code, width }: { code: number; width: number }): string =>
  code.toString(16).padStart(width, '0')

const escaped = ({ char, quote }: { char: string; quote: string }): string => {
  if (char === quote) {
    return `\\${quote}`
  }
  const named = NAMED_ESCAPES.get(char)
  if (named !== undefined) {
    return named
  }
  if (char === ' ' || !UNPRINTABLE.test(char)) {
    return char
  }
  const code = char.codePointAt(0) ?? 0
  if (code <= 0xff) {
    return `\\x${hex({ code, width: 2 })}`
  }
  return code <= 0xffff ? `\\u${hex({ code, width: 4 })}` : `\\U${hex({ code, width: 8 })}`
}

const pythonRepr = (text: string): string => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  return `${quote}${[...text].map((char) => escaped({ char, quote })).join('')}${quote}`
}

/**
 * The shared filters, validated. An unknown host is a client error: the
 * fleet is known, and a typo must not silently answer for nobody.
 */
export const playQuery = ({
  days,
  host,
  kind,
  quality,
}: z.infer<typeof FilterQuery>): PlayQuery => {
  if (host !== undefined && !plexHosts().some((plex) => plex.name === host)) {
    throw httpError({ status: 422, detail: `unknown host ${pythonRepr(host)}` })
  }
  const now = new Date()
  const since =
    days === 0 ? null : epochSeconds(addSeconds({ at: now, seconds: -days * DAY_SECONDS }))
  return {
    days,
    filters: plays.filters({
      since,
      host: host ?? null,
      kind: kind ?? null,
      quality: quality ?? null,
    }),
    now,
  }
}

@Controller('plays')
@UseGuards(SupabaseAdminGuard)
export class PlaysController {
  /**
   * Everything the overview panel draws, in one read.
   *
   * by_kind, by_quality and by_host are zero-filled: a bucket with no plays
   * is a bucket at zero, not a bucket that vanished, and the host list keeps
   * config order so position stays identity across every view.
   */
  @Get('overview')
  overview(@Query({ schema: FilterQuery }) params: z.infer<typeof FilterQuery>): PlaysOverviewView {
    const query = playQuery(params)
    const names = plexHosts().map((plex) => plex.name)
    const data = session({
      path: dbPath(),
      mode: 'read',
      work: (connection) =>
        plays.overview({ connection, filters: query.filters, hosts: names, now: query.now }),
    })
    return {
      window: playsWindow(query),
      totals: data.totals,
      by_kind: data.by_kind,
      by_quality: data.by_quality,
      by_host: data.by_host,
      timeline: data.timeline,
      top_viewers: data.top_viewers,
      top_titles: data.top_titles,
    }
  }

  /** Every viewer with a completed play under the filters, most first. */
  @Get('users')
  users(@Query({ schema: FilterQuery }) params: z.infer<typeof FilterQuery>): PlayUsersView {
    const query = playQuery(params)
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) => ({ users: plays.users({ connection, filters: query.filters }) }),
    })
  }

  /**
   * One viewer's plays, newest first, a page at a time. A viewer nobody has
   * named is still answered for, under their account id.
   */
  @Get('users/:account_id/history')
  userHistory(
    @Param('account_id', { schema: AccountId }) accountId: z.infer<typeof AccountId>,
    @Query({ schema: PagedQuery }) params: z.infer<typeof PagedQuery>,
  ): plays.HistoryPage {
    const query = playQuery(params)
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) =>
        plays.userHistory({
          connection,
          filters: query.filters,
          accountId,
          page: params.page,
          pageSize: params.page_size,
        }),
    })
  }

  /**
   * Every completed play of one title, newest first, a page at a time.
   *
   * The key travels as a query parameter rather than a path segment because
   * it carries the title itself, slashes and all. A key nothing answers to is
   * an empty page: a link older than the library it names is stale, not
   * wrong.
   */
  @Get('title')
  titleHistory(
    @Query({ schema: TitleQuery }) params: z.infer<typeof TitleQuery>,
  ): plays.TitleHistoryPage {
    const query = playQuery(params)
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) =>
        plays.titleHistory({
          connection,
          filters: query.filters,
          key: params.key,
          page: params.page,
          pageSize: params.page_size,
        }),
    })
  }

  /**
   * Titles ranked by completed plays, or by rewatches, grouped the way a
   * viewer names them: a film, a show, an album.
   */
  @Get('top')
  top(@Query({ schema: TopQuery }) params: z.infer<typeof TopQuery>): TopTitlesView {
    const query = playQuery(params)
    const titles = session({
      path: dbPath(),
      mode: 'read',
      work: (connection) =>
        plays.topTitles({
          connection,
          filters: query.filters,
          metric: params.metric,
          limit: params.limit,
        }),
    })
    return { metric: params.metric, titles }
  }

  /**
   * What is in the libraries with no completed play inside the window, newest
   * addition first. With days=0 that is never played at all, as far as the
   * ledger goes.
   */
  @Get('never-played')
  neverPlayed(
    @Query({ schema: NeverPlayedQuery }) params: z.infer<typeof NeverPlayedQuery>,
  ): plays.NeverPlayedPage {
    const query = playQuery(params)
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) =>
        plays.neverPlayed({
          connection,
          filters: query.filters,
          hosts: plexHosts().map((plex) => plex.name),
          page: params.page,
          pageSize: params.page_size,
          q: params.q,
          now: query.now,
        }),
    })
  }

  /**
   * Where the ledger stands on every Plex host, whether or not a pass has
   * ever reached it: a host with no row is listed unreachable and empty
   * rather than left out, since absence from the page would read as absence
   * from the fleet.
   */
  @Get('sync')
  sync(): PlaySyncView {
    const servers = session({
      path: dbPath(),
      mode: 'read',
      work: (connection) => plays.syncStatus({ connection, hosts: plexHosts() }),
    })
    return { lookback_days: plexLookbackDays(), servers }
  }
}
