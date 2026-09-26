// What nobody has finished: the unplayed set, its summary, and one page of
// rows.
//
// Its own dialect of the filters, because it narrows the library rather than
// the ledger: a group is never-played when no member of it was played, and a
// quality filter reads the item's own rank rather than a play's.

import type { Connection } from '@/db.js'
import * as base from '@/plays/base.js'
import { type Kind, type Quality, QUALITY_RANK } from '@/probes/plex.js'
import { asRow, asRows, fields } from '@/rows.js'
import { epochSeconds } from '@/time.js'

export type NeverKind = 'movie' | 'show' | 'album'

export type NeverPlayedRow = Readonly<{
  key: string
  host: string
  kind: NeverKind
  // The dataclass said `str`, but a show whose episodes carry a show key and
  // no show title groups under MIN(grandparent_title), which is NULL, and
  // Python served that null as is. Typed for what is really on the wire.
  title: string | null
  context: string | null
  year: number | null
  quality: Quality | null
  library: string | null
  added_at: Date | null
  items: number
  thumb: string | null
}>

export type NeverQualityCount = Readonly<{
  quality: base.QualityFilter
  count: number
}>

export type NeverHostCount = Readonly<{
  host: string
  count: number
}>

export type NeverPlayedSummary = Readonly<{
  movies: number
  shows: number
  albums: number
  by_quality: readonly NeverQualityCount[]
  by_host: readonly NeverHostCount[]
}>

export type NeverPlayedPage = Readonly<{
  summary: NeverPlayedSummary
  total: number
  page: number
  page_size: number
  rows: readonly NeverPlayedRow[]
}>

const NEVER_KIND: Readonly<Record<Kind, NeverKind>> = {
  movie: 'movie',
  episode: 'show',
  track: 'album',
}

const isNeverKind = (value: string): value is NeverKind =>
  value === 'movie' || value === 'show' || value === 'album'

/** A stored never-played kind, narrowed; the SQL below only ever writes three. */
const neverKindOf = (value: string): NeverKind => {
  if (!isNeverKind(value)) {
    throw new TypeError(`not a never-played kind: ${value}`)
  }
  return value
}

// Everything in the library nobody has finished inside the window, grouped
// the way the ranked views group: a film is itself, a show is one row however
// many episodes it has, an album likewise. A show or album with one played
// episode or track is not never-played, so the group is kept only when none
// of its members was.
const unplayedCte = ({
  playedWhere,
  candidatesWhere,
}: {
  playedWhere: string
  candidatesWhere: string
}): string => `
WITH played AS (
    SELECT DISTINCT host, rating_key FROM plex_plays ${playedWhere}
),
candidates AS (
    SELECT i.host, i.rating_key, i.kind, i.title, i.parent_rating_key, i.parent_title,
           i.grandparent_rating_key, i.grandparent_title, i.year, i.section_id, i.added_at,
           i.thumb,
           ${base.rankSql('i.quality')} AS quality_rank,
           (p.rating_key IS NOT NULL) AS played
    FROM plex_items i
    LEFT JOIN played p ON p.host = i.host AND p.rating_key = i.rating_key
    ${candidatesWhere}
),
unplayed AS (
    SELECT host, 'movie' AS kind, host || ':movie:' || rating_key AS key, title,
           NULL AS context, year, quality_rank, section_id, added_at, 1 AS items, thumb
    FROM candidates
    WHERE kind = 'movie' AND played = 0
    UNION ALL
    SELECT host, 'show', host || ':show:' || grandparent_rating_key, MIN(grandparent_title),
           NULL, NULL, MAX(quality_rank), MIN(section_id), MAX(added_at), COUNT(*), MIN(thumb)
    FROM candidates
    WHERE kind = 'episode' AND grandparent_rating_key IS NOT NULL
    GROUP BY host, grandparent_rating_key
    HAVING SUM(played) = 0
    UNION ALL
    SELECT host, 'album', host || ':album:' || parent_rating_key, MIN(parent_title),
           MIN(grandparent_title), NULL, 0, MIN(section_id), MAX(added_at), COUNT(*), MIN(thumb)
    FROM candidates
    WHERE kind = 'track' AND parent_rating_key IS NOT NULL
    GROUP BY host, parent_rating_key
    HAVING SUM(played) = 0
)
`

/**
 * What nobody has finished inside the window, newest addition first.
 *
 * The summary keeps the whole picture under the window, host and search while
 * the rows narrow further by kind and quality, so a reader looking at 4K films
 * still sees how many shows and albums sit unwatched beside them.
 *
 * `now` is what separates a real addition date from an impossible one. Plex
 * carries a few items stamped decades ahead (QI on meleys says 2098), and
 * sorted newest first those sit at the top of the list forever, over every
 * title actually added this week.
 */
export const neverPlayed = ({
  connection,
  filters,
  hosts,
  page,
  pageSize,
  q,
  now,
}: {
  connection: Connection
  filters: base.Filters
  hosts: readonly string[]
  page: number
  pageSize: number
  q: string
  now: Date
}): NeverPlayedPage => {
  const cte = unplayedCte({
    playedWhere: base.where(filters.since === null ? '' : 'viewed_at >= ?'),
    candidatesWhere: base.where('i.present = 1', filters.host === null ? '' : 'i.host = ?'),
  })
  // in the order the two clauses appear above
  const params = [filters.since, filters.host].filter(
    (value): value is string | number => value !== null,
  )

  // Materialised once per request. sqlite evaluates a CTE afresh in every
  // statement that names it, and this request makes five: over the fleet's
  // 177,000 items that was a second per read, and the page reads it on every
  // filter press. The temp table lives in this connection only, which the
  // session opened for this one request, and it is dropped on the way out so a
  // connection a test holds open stays clean.
  connection.prepare('DROP TABLE IF EXISTS unplayed_now').run()
  connection
    .prepare(`CREATE TEMP TABLE unplayed_now AS ${cte} SELECT * FROM unplayed`)
    .run(...params)
  try {
    return neverPlayedPage({ connection, filters, hosts, page, pageSize, q, now })
  } finally {
    connection.prepare('DROP TABLE IF EXISTS unplayed_now').run()
  }
}

/**
 * The unplayed dialect of `base.conditions`: the same kind and quality
 * narrowing, read off the library row's own rank rather than a play's item,
 * and spoken in the three kinds this view groups by.
 *
 * Every clause names the alias, because the rows query joins the sections
 * table, which has `kind` and `title` columns of its own, and a bare column
 * name there is an ambiguity error rather than a filter.
 */
export const unplayedConditions = (
  filters: base.Filters,
): readonly [readonly string[], readonly base.Param[]] => {
  const kindClauses: readonly string[] = filters.kind === null ? [] : ['u.kind = ?']
  const kindParams: readonly base.Param[] = filters.kind === null ? [] : [NEVER_KIND[filters.kind]]
  const [qualityClauses, qualityParams]: readonly [readonly string[], readonly base.Param[]] =
    filters.quality === 'other'
      ? // unknown or sd video; an album has no video and is not "other"
        [[`u.kind != 'album' AND u.quality_rank <= ${base.OTHER_RANK_MAX}`], []]
      : filters.quality === null
        ? [[], []]
        : [["u.kind != 'album' AND u.quality_rank = ?"], [QUALITY_RANK[filters.quality]]]
  return [
    [...kindClauses, ...qualityClauses],
    [...kindParams, ...qualityParams],
  ]
}

/** The summary and one page of rows, read from the materialised set. */
const neverPlayedPage = ({
  connection,
  filters,
  hosts,
  page,
  pageSize,
  q,
  now,
}: {
  connection: Connection
  filters: base.Filters
  hosts: readonly string[]
  page: number
  pageSize: number
  q: string
  now: Date
}): NeverPlayedPage => {
  const search = q.trim()
  // instr rather than LIKE, so a % or _ in the search is a character
  const searchClause = search ? 'instr(lower(u.title), lower(?)) > 0' : ''
  const searchParams: readonly base.Param[] = search ? [search] : []

  const summaryWhere = base.where(searchClause)
  const kinds = base.counts({
    connection,
    sql: `SELECT u.kind, COUNT(*) FROM unplayed_now u ${summaryWhere} GROUP BY u.kind`,
    params: searchParams,
  })
  const movieWhere = base.where("u.kind = 'movie'", searchClause)
  const byQuality = base.counts({
    connection,
    sql: `
            SELECT ${base.filterSql('u.quality_rank')} AS q, COUNT(*)
            FROM unplayed_now u ${movieWhere}
            GROUP BY q
            `,
    params: searchParams,
  })
  const byHost = base.counts({
    connection,
    sql: `SELECT u.host, COUNT(*) FROM unplayed_now u ${summaryWhere} GROUP BY u.host`,
    params: searchParams,
  })

  const [rowClauses, rowFilters] = unplayedConditions(filters)
  const rowWhere = base.where(searchClause, ...rowClauses)
  const rowParams = [...searchParams, ...rowFilters]

  const counted = asRow(
    connection
      .prepare(`SELECT COUNT(*) AS total FROM unplayed_now u ${rowWhere}`)
      .get(...rowParams),
  )
  if (counted === null) {
    throw new TypeError('a count over the unplayed set answered no row')
  }
  const total = fields(counted).number('total')
  const rows = asRows(
    connection
      .prepare(
        `
        SELECT u.*, s.title AS library
        FROM unplayed_now u
        LEFT JOIN plex_sections s ON s.host = u.host AND s.section_id = u.section_id
        ${rowWhere}
        ORDER BY (u.added_at IS NULL OR u.added_at > ?), u.added_at DESC, u.title
        LIMIT ? OFFSET ?
        `,
      )
      .all(...rowParams, epochSeconds(now), pageSize, (page - 1) * pageSize),
  )

  return {
    summary: {
      movies: kinds.get('movie') ?? 0,
      shows: kinds.get('show') ?? 0,
      albums: kinds.get('album') ?? 0,
      by_quality: base.QUALITY_FILTERS.map((quality) => ({
        quality,
        count: byQuality.get(quality) ?? 0,
      })),
      by_host: hosts.map((name) => ({ host: name, count: byHost.get(name) ?? 0 })),
    },
    total,
    page,
    page_size: pageSize,
    rows: rows.map((row): NeverPlayedRow => {
      const column = fields(row)
      return {
        key: column.text('key'),
        host: column.text('host'),
        kind: neverKindOf(column.text('kind')),
        title: column.textOrNull('title'),
        context: column.textOrNull('context'),
        year: column.numberOrNull('year'),
        quality: base.quality(column.numberOrNull('quality_rank')),
        library: column.textOrNull('library'),
        added_at: base.utcOrNone(column.numberOrNull('added_at')),
        items: column.number('items'),
        thumb: column.textOrNull('thumb'),
      }
    }),
  }
}
