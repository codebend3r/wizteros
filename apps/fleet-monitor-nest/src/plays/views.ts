// The aggregates the plays page draws: the overview, the ranked titles, the
// viewers, and the two paged histories.
//
// Each one narrows the ledger through `base` and shapes the rows into the
// records the API serves.

import type { Connection } from '@/db.js'
import * as base from '@/plays/base.js'
import * as ledger from '@/plays/ledger.js'
import type { Kind, Quality } from '@/probes/plex.js'
import { asRow, asRows, fields, type Row } from '@/rows.js'
import { epochSeconds } from '@/time.js'

export type Metric = 'plays' | 'rewatches'
export type Bucket = 'day' | 'week' | 'month'

// Windows up to a month are drawn by day, up to half a year by week, and
// anything wider by month, so a year of history is twelve bars rather than
// three hundred and sixty five slivers.
const DAY_BUCKET_MAX_DAYS = 31
const WEEK_BUCKET_MAX_DAYS = 180
const TOP_COUNT = 5

export type Totals = Readonly<{
  plays: number
  viewers: number
  titles: number
  watch_ms: number
}>

export type KindCount = Readonly<{
  kind: Kind
  plays: number
}>

export type QualityCount = Readonly<{
  quality: base.QualityFilter
  plays: number
}>

export type HostCount = Readonly<{
  host: string
  friendly_name: string | null
  plays: number
}>

export type TimelinePoint = Readonly<{
  start: string
  plays: number
  hosts: Readonly<Record<string, number>>
}>

export type Timeline = Readonly<{
  bucket: Bucket
  points: readonly TimelinePoint[]
}>

export type Viewer = Readonly<{
  account_id: number
  name: string
  plays: number
}>

export type Rewatcher = Readonly<{
  account_id: number
  name: string
  plays: number
}>

export type TopTitle = Readonly<{
  key: string
  kind: Kind
  title: string
  context: string | null
  year: number | null
  quality: Quality | null
  plays: number
  viewers: number
  items: number
  rewatches: number
  top_rewatcher: Rewatcher | null
  last_viewed_at: Date
  hosts: readonly string[]
  thumb: string | null
}>

export type Overview = Readonly<{
  totals: Totals
  by_kind: readonly KindCount[]
  by_quality: readonly QualityCount[]
  by_host: readonly HostCount[]
  timeline: Timeline
  top_viewers: readonly Viewer[]
  top_titles: readonly TopTitle[]
}>

export type User = Readonly<{
  account_id: number
  name: string
  thumb: string | null
  plays: number
  movies: number
  episodes: number
  tracks: number
  hosts: readonly string[]
  last_viewed_at: Date | null
  top_title: string | null
}>

export type HistoryRow = Readonly<{
  viewed_at: Date
  host: string
  kind: Kind
  // The group the play belongs to, so a row can link to that title's own
  // history without the page having to rebuild the key from the columns.
  group_key: string
  title: string
  parent_title: string | null
  grandparent_title: string | null
  index: number | null
  parent_index: number | null
  year: number | null
  quality: Quality | null
  device: string | null
  library: string | null
  duration_ms: number | null
}>

export type HistoryPage = Readonly<{
  account_id: number
  name: string
  total: number
  page: number
  page_size: number
  rows: readonly HistoryRow[]
}>

/**
 * One completion of one item under a title, named by who finished it.
 *
 * `title` is the item, not the group: the episode, the track, the film. The
 * group's own name is on the page around it.
 */
export type TitleHistoryRow = Readonly<{
  viewed_at: Date
  host: string
  kind: Kind
  account_id: number
  viewer: string
  title: string
  index: number | null
  parent_index: number | null
  year: number | null
  quality: Quality | null
  device: string | null
  library: string | null
  duration_ms: number | null
}>

/**
 * Every completed play of one title, with the figures that scope them.
 *
 * `kind` and `title` are null and empty only for a key nothing in the ledger
 * answers to, which is a stale link rather than an error. They are read
 * outside the window when the window holds no play, so a narrowed filter
 * leaves the page named rather than blank.
 */
export type TitleHistoryPage = Readonly<{
  key: string
  kind: Kind | null
  title: string
  context: string | null
  year: number | null
  quality: Quality | null
  viewers: number
  items: number
  rewatches: number
  first_viewed_at: Date | null
  last_viewed_at: Date | null
  hosts: readonly string[]
  total: number
  page: number
  page_size: number
  rows: readonly TitleHistoryRow[]
}>

/** The one row an aggregate always answers with, narrowed. */
const aggregateRow = (value: unknown) => {
  const row = asRow(value)
  if (row === null) {
    throw new TypeError('an aggregate answered no row')
  }
  return fields(row)
}

const bucketFor = ({ since, now }: { since: number | null; now: Date }): Bucket => {
  if (since === null) {
    return 'month'
  }
  const days = (epochSeconds(now) - since) / 86_400
  if (days <= DAY_BUCKET_MAX_DAYS) {
    return 'day'
  }
  if (days <= WEEK_BUCKET_MAX_DAYS) {
    return 'week'
  }
  return 'month'
}

// Local dates, so a play at eleven at night lands on the day it was watched
// rather than the UTC day it spilled into. The container carries the NAS's TZ.
const BUCKET_SQL: Readonly<Record<Bucket, string>> = {
  day: "date(viewed_at, 'unixepoch', 'localtime')",
  // back six days then forward to the next Monday, which is the Monday on or
  // before the play: 'weekday 1' alone would push a Monday a week ahead
  week: "date(viewed_at, 'unixepoch', 'localtime', '-6 days', 'weekday 1')",
  month: "strftime('%Y-%m-01', viewed_at, 'unixepoch', 'localtime')",
}

/**
 * The most played, or most rewatched, groups under the filters.
 *
 * Ties fall to the more recently played, so a page sorted by plays does not
 * reshuffle its equal rows between refreshes.
 */
export const topTitles = ({
  connection,
  filters,
  metric,
  limit,
}: {
  connection: Connection
  filters: base.Filters
  metric: Metric
  limit: number
}): readonly TopTitle[] =>
  base.baseTable({
    connection,
    filters,
    work: (table) => topTitlesFrom({ connection, table, metric, limit }),
  })

/**
 * The ranking itself, over a base table the caller already opened, so
 * `overview` ranks from the same one it totals from.
 */
const topTitlesFrom = ({
  connection,
  table,
  metric,
  limit,
}: {
  connection: Connection
  table: string
  metric: Metric
  limit: number
}): readonly TopTitle[] => {
  const onlyRewatched = metric === 'rewatches' ? 'WHERE r.rewatches > 0' : ''
  const order = metric === 'rewatches' ? 'r.rewatches DESC, g.plays DESC' : 'g.plays DESC'
  const rows = asRows(
    connection
      .prepare(
        `
        WITH per_item AS (
            SELECT group_key, account_id, host, rating_key, COUNT(*) AS plays
            FROM ${table}
            GROUP BY group_key, account_id, host, rating_key
        ),
        groups AS (
            SELECT group_key,
                   MIN(kind) AS kind,
                   MIN(group_title) AS title,
                   MIN(group_context) AS context,
                   MIN(group_year) AS year,
                   COUNT(*) AS plays,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT host || ':' || rating_key) AS items,
                   MAX(viewed_at) AS last_viewed_at,
                   MAX(quality_rank) AS quality_rank,
                   GROUP_CONCAT(DISTINCT host) AS hosts,
                   MAX(thumb) AS thumb
            FROM ${table}
            GROUP BY group_key
        ),
        rewatches AS (
            SELECT group_key, SUM(plays - 1) AS rewatches FROM per_item GROUP BY group_key
        ),
        rewatcher AS (
            -- sqlite hands back the bare column from the row holding the max
            SELECT group_key, account_id, MAX(plays) AS plays FROM per_item GROUP BY group_key
        )
        SELECT g.*, r.rewatches, w.account_id AS rewatcher_id, w.plays AS rewatcher_plays
        FROM groups g
        JOIN rewatches r ON r.group_key = g.group_key
        JOIN rewatcher w ON w.group_key = g.group_key
        ${onlyRewatched}
        ORDER BY ${order}, g.last_viewed_at DESC, g.title
        LIMIT ?
        `,
      )
      .all(limit),
  )
  const [names] = base.identities(connection)
  return rows.map((row): TopTitle => {
    const column = fields(row)
    const rewatcherId = column.number('rewatcher_id')
    const rewatcherPlays = column.number('rewatcher_plays')
    return {
      key: column.text('group_key'),
      kind: base.kindOf(column.text('kind')),
      title: column.text('title'),
      context: column.textOrNull('context'),
      year: column.numberOrNull('year'),
      quality: base.quality(column.numberOrNull('quality_rank')),
      plays: column.number('plays'),
      viewers: column.number('viewers'),
      items: column.number('items'),
      rewatches: column.number('rewatches'),
      top_rewatcher:
        rewatcherPlays > 1
          ? {
              account_id: rewatcherId,
              name: base.name({ names, accountId: rewatcherId }),
              plays: rewatcherPlays,
            }
          : null,
      last_viewed_at: base.utc(column.number('last_viewed_at')),
      hosts: base.hosts(column.textOrNull('hosts')),
      thumb: column.textOrNull('thumb'),
    }
  })
}

/**
 * Everything the overview panel draws, in one read.
 *
 * `hosts` is the fleet in config order: by_host is zero-filled in that order
 * because the portal binds one colour per position, the same binding the
 * fleet page uses, and a host with no plays must keep its slot.
 */
export const overview = ({
  connection,
  filters,
  hosts,
  now,
}: {
  connection: Connection
  filters: base.Filters
  hosts: readonly string[]
  now: Date
}): Overview =>
  base.baseTable({
    connection,
    filters,
    work: (table): Overview => {
      const totals = aggregateRow(
        connection
          .prepare(
            `
            SELECT COUNT(*) AS plays,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT group_key) AS titles,
                   COALESCE(SUM(duration_ms), 0) AS watch_ms
            FROM ${table}
            `,
          )
          .get(),
      )
      const byKind = base.counts({
        connection,
        sql: `SELECT kind, COUNT(*) FROM ${table} GROUP BY kind`,
      })
      const byQuality = base.counts({
        connection,
        sql: `
                SELECT ${base.filterSql('quality_rank')} AS q, COUNT(*)
                FROM ${table}
                WHERE kind != 'track'
                GROUP BY q
                `,
      })
      const byHost = base.counts({
        connection,
        sql: `SELECT host, COUNT(*) FROM ${table} GROUP BY host`,
      })
      const friendly: ReadonlyMap<string, string | null> = new Map(
        asRows(connection.prepare('SELECT host, friendly_name FROM plex_servers').all()).map(
          (row) => [fields(row).text('host'), fields(row).textOrNull('friendly_name')] as const,
        ),
      )

      const since =
        filters.since === null
          ? ledger.earliestPlay({ connection, host: filters.host })
          : filters.since
      const bucket = bucketFor({ since, now })
      const points = asRows(
        connection
          .prepare(
            `
            SELECT ${BUCKET_SQL[bucket]} AS start, host, COUNT(*) AS plays
            FROM ${table}
            GROUP BY start, host
            ORDER BY start, host
            `,
          )
          .all(),
      ).reduce((found, row) => {
        const start = fields(row).text('start')
        return found.set(start, {
          ...found.get(start),
          [fields(row).text('host')]: fields(row).number('plays'),
        })
      }, new Map<string, Readonly<Record<string, number>>>())

      const [names] = base.identities(connection)
      const viewers = asRows(
        connection
          .prepare(
            `
            SELECT account_id, COUNT(*) AS plays
            FROM ${table}
            GROUP BY account_id
            ORDER BY plays DESC, account_id
            LIMIT ?
            `,
          )
          .all(TOP_COUNT),
      )

      return {
        totals: {
          plays: totals.number('plays'),
          viewers: totals.number('viewers'),
          titles: totals.number('titles'),
          watch_ms: totals.number('watch_ms'),
        },
        by_kind: base.KIND_ORDER.map((kind) => ({ kind, plays: byKind.get(kind) ?? 0 })),
        by_quality: base.QUALITY_FILTERS.map((quality) => ({
          quality,
          plays: byQuality.get(quality) ?? 0,
        })),
        by_host: hosts.map((host) => ({
          host,
          friendly_name: friendly.get(host) ?? null,
          plays: byHost.get(host) ?? 0,
        })),
        timeline: {
          bucket,
          points: [...points].map(([start, perHost]) => ({
            start,
            plays: Object.values(perHost).reduce((sum, plays) => sum + plays, 0),
            hosts: perHost,
          })),
        },
        top_viewers: viewers.map((row) => {
          const accountId = fields(row).number('account_id')
          return {
            account_id: accountId,
            name: base.name({ names, accountId }),
            plays: fields(row).number('plays'),
          }
        }),
        top_titles: topTitlesFrom({ connection, table, metric: 'plays', limit: TOP_COUNT }),
      }
    },
  })

/** Every viewer with a play under the filters, most plays first. */
export const users = ({
  connection,
  filters,
}: {
  connection: Connection
  filters: base.Filters
}): readonly User[] => {
  const [rows, favourites] = base.baseTable({
    connection,
    filters,
    work: (table) => {
      const ranked = asRows(
        connection
          .prepare(
            `
            SELECT account_id,
                   COUNT(*) AS plays,
                   SUM(kind = 'movie') AS movies,
                   SUM(kind = 'episode') AS episodes,
                   SUM(kind = 'track') AS tracks,
                   MAX(viewed_at) AS last_viewed_at,
                   GROUP_CONCAT(DISTINCT host) AS hosts
            FROM ${table}
            GROUP BY account_id
            ORDER BY plays DESC, account_id
            `,
          )
          .all(),
      )
      // the group a viewer has played most, alphabetical on a tie so the
      // favourite does not flicker between refreshes
      const favourite = asRows(
        connection
          .prepare(
            `
            SELECT account_id, group_title, COUNT(*) AS plays
            FROM ${table}
            GROUP BY account_id, group_key
            ORDER BY account_id, plays DESC, group_title
            `,
          )
          .all(),
      ).reduce((found, row) => {
        const accountId = fields(row).number('account_id')
        return found.has(accountId) ? found : found.set(accountId, fields(row).text('group_title'))
      }, new Map<number, string>())
      return [ranked, favourite] as const
    },
  })
  const [names, thumbs] = base.identities(connection)
  return rows.map((row): User => {
    const column = fields(row)
    const accountId = column.number('account_id')
    return {
      account_id: accountId,
      name: base.name({ names, accountId }),
      thumb: thumbs.get(accountId) ?? null,
      plays: column.number('plays'),
      movies: column.number('movies'),
      episodes: column.number('episodes'),
      tracks: column.number('tracks'),
      hosts: base.hosts(column.textOrNull('hosts')),
      last_viewed_at: base.utc(column.number('last_viewed_at')),
      top_title: favourites.get(accountId) ?? null,
    }
  })
}

// Every column either history draws, so the two read the same rows and each
// keeps the shape it puts on the wire.
const PAGE_COLUMNS = `
    b.viewed_at, b.host, b.kind, b.account_id, b.group_key, b.item_title AS title,
    b.parent_title, b.grandparent_title, b.item_index, b.parent_index, b.year,
    b.quality, b.duration_ms, d.name AS device, s.title AS library
`

/**
 * One page of plays from an open base table, newest first, each named by the
 * device that played it and the library it sits in.
 */
const pageOfPlays = ({
  connection,
  table,
  where = '',
  params = [],
  page,
  pageSize,
}: {
  connection: Connection
  table: string
  where?: string
  params?: readonly base.Param[]
  page: number
  pageSize: number
}): Row[] =>
  asRows(
    connection
      .prepare(
        `
        SELECT ${PAGE_COLUMNS}
        FROM ${table} b
        LEFT JOIN plex_devices d ON d.host = b.host AND d.device_id = b.device_id
        LEFT JOIN plex_sections s ON s.host = b.host AND s.section_id = b.section_id
        ${where}
        ORDER BY b.viewed_at DESC, b.history_id DESC
        LIMIT ? OFFSET ?
        `,
      )
      .all(...params, pageSize, (page - 1) * pageSize),
  )

/** One viewer's plays, newest first, one page at a time. */
export const userHistory = ({
  connection,
  filters,
  accountId,
  page,
  pageSize,
}: {
  connection: Connection
  filters: base.Filters
  accountId: number
  page: number
  pageSize: number
}): HistoryPage => {
  const [total, rows] = base.baseTable({
    connection,
    filters,
    extra: ['p.account_id = ?'],
    extraParams: [accountId],
    work: (table) => {
      const counted = aggregateRow(
        connection.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
      )
      return [counted.number('total'), pageOfPlays({ connection, table, page, pageSize })] as const
    },
  })
  const [names] = base.identities(connection)
  return {
    account_id: accountId,
    name: base.name({ names, accountId }),
    total,
    page,
    page_size: pageSize,
    rows: rows.map((row): HistoryRow => {
      const column = fields(row)
      return {
        viewed_at: base.utc(column.number('viewed_at')),
        host: column.text('host'),
        kind: base.kindOf(column.text('kind')),
        group_key: column.text('group_key'),
        title: column.text('title'),
        parent_title: column.textOrNull('parent_title'),
        grandparent_title: column.textOrNull('grandparent_title'),
        index: column.numberOrNull('item_index'),
        parent_index: column.numberOrNull('parent_index'),
        year: column.numberOrNull('year'),
        quality: base.qualityLabel(column.textOrNull('quality')),
        device: column.textOrNull('device'),
        library: column.textOrNull('library'),
        duration_ms: column.numberOrNull('duration_ms'),
      }
    }),
  }
}

// What names a group, read from its most recent play. Used on its own, with
// no window, so a title stays named under a filter that holds none of its
// plays: the page has only the key, and an unnamed heading would read as a
// title that had been deleted rather than one nobody watched this month.
const titleIdentitySql = (table: string): string => `
    SELECT kind, group_title, group_context, group_year, quality_rank
    FROM ${table}
    WHERE group_key = ?
    ORDER BY viewed_at DESC, history_id DESC
    LIMIT 1
`

type Identity = Readonly<{
  kind: string | null
  title: string | null
  context: string | null
  year: number | null
  quality_rank: number | null
}>

/**
 * Every completed play of one title, newest first, a page at a time.
 *
 * The key is a group key as `topTitles` and `userHistory` hand it out: a film,
 * a show, an album, or a single item whose metadata never arrived. An unknown
 * key is an empty page rather than an error, because a link older than the
 * library it names is a stale link, not a fault.
 */
export const titleHistory = ({
  connection,
  filters,
  key,
  page,
  pageSize,
}: {
  connection: Connection
  filters: base.Filters
  key: string
  page: number
  pageSize: number
}): TitleHistoryPage => {
  const [summary, identity, names, rows] = base.baseTable({
    connection,
    filters,
    work: (table) => {
      const scoped = aggregateRow(
        connection
          .prepare(
            `
            WITH scoped AS (SELECT * FROM ${table} WHERE group_key = ?),
            per_item AS (
                SELECT account_id, host, rating_key, COUNT(*) AS plays
                FROM scoped
                GROUP BY account_id, host, rating_key
            )
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT host || ':' || rating_key) AS items,
                   MIN(viewed_at) AS first_viewed_at,
                   MAX(viewed_at) AS last_viewed_at,
                   MAX(quality_rank) AS quality_rank,
                   GROUP_CONCAT(DISTINCT host) AS hosts,
                   MIN(kind) AS kind,
                   MIN(group_title) AS title,
                   MIN(group_context) AS context,
                   MIN(group_year) AS year,
                   (SELECT COALESCE(SUM(plays - 1), 0) FROM per_item) AS rewatches
            FROM scoped
            `,
          )
          .get(key),
      )
      const windowed: Identity = {
        kind: scoped.textOrNull('kind'),
        title: scoped.textOrNull('title'),
        context: scoped.textOrNull('context'),
        year: scoped.numberOrNull('year'),
        quality_rank: scoped.numberOrNull('quality_rank'),
      }
      // nothing under the filters: name the title from the ledger at large,
      // under its own name so the window's table stands
      const named =
        windowed.kind === null
          ? base.baseTable({
              connection,
              filters: base.filters(),
              table: 'base_all',
              work: (unfiltered) =>
                asRow(connection.prepare(titleIdentitySql(unfiltered)).get(key)),
            })
          : null
      const ledgerWide: Identity | null =
        named === null
          ? null
          : {
              kind: fields(named).textOrNull('kind'),
              title: fields(named).textOrNull('group_title'),
              context: fields(named).textOrNull('group_context'),
              year: fields(named).numberOrNull('group_year'),
              quality_rank: fields(named).numberOrNull('quality_rank'),
            }

      const [known] = base.identities(connection)
      const pageRows = pageOfPlays({
        connection,
        table,
        where: 'WHERE b.group_key = ?',
        params: [key],
        page,
        pageSize,
      })
      return [scoped, ledgerWide ?? windowed, known, pageRows] as const
    },
  })

  return {
    key,
    kind: base.kindOrNull(identity.kind),
    title: identity.title || '',
    context: identity.context,
    year: identity.year,
    quality: base.quality(identity.quality_rank),
    viewers: summary.number('viewers'),
    items: summary.number('items'),
    rewatches: summary.number('rewatches'),
    first_viewed_at: base.utcOrNone(summary.numberOrNull('first_viewed_at')),
    last_viewed_at: base.utcOrNone(summary.numberOrNull('last_viewed_at')),
    hosts: base.hosts(summary.textOrNull('hosts')),
    total: summary.number('total'),
    page,
    page_size: pageSize,
    rows: rows.map((row): TitleHistoryRow => {
      const column = fields(row)
      const accountId = column.number('account_id')
      return {
        viewed_at: base.utc(column.number('viewed_at')),
        host: column.text('host'),
        kind: base.kindOf(column.text('kind')),
        account_id: accountId,
        viewer: base.name({ names, accountId }),
        title: column.text('title'),
        index: column.numberOrNull('item_index'),
        parent_index: column.numberOrNull('parent_index'),
        year: column.numberOrNull('year'),
        quality: base.qualityLabel(column.textOrNull('quality')),
        device: column.textOrNull('device'),
        library: column.textOrNull('library'),
        duration_ms: column.numberOrNull('duration_ms'),
      }
    }),
  }
}
