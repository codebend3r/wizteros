// The aggregates the plays page draws: the overview, the ranked titles and
// the viewers. The three paged histories are in `history`.
//
// Each one narrows the ledger through `base` and shapes the rows into the
// records the API serves.

import type { Connection } from '@/db.js'
import * as base from '@/plays/base.js'
import * as ledger from '@/plays/ledger.js'
import type { Kind, Quality } from '@/probes/plex.js'
import { asRows, epochSeconds, fields } from '@wizteros/server-common'

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
      const totals = base.aggregateRow(
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
