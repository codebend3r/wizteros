// What every play view is built from: the filters, the joined select the
// aggregates read, and the small conversions their rows need.
//
// `baseTable` holds, for one request, the plays that request asked for, and
// every aggregate reads it. The rest of this module is what builds that table
// and what turns a stored column into the value a record carries.

import type { Connection } from '@/db.js'
import { type Kind, KINDS, type Quality, QUALITY_RANK } from '@/probes/plex.js'
import { asRows, fields } from '@/rows.js'
import { parseIso } from '@/time.js'

// The four buckets the page groups video by, in the order it lists them.
// `other` folds sd and unknown together: a play whose item was deleted since
// has no resolution on record, and inventing one would be worse than a fourth
// column.
export type QualityFilter = '4k' | '1080p' | '720p' | 'other'
export const QUALITY_FILTERS: readonly QualityFilter[] = ['4k', '1080p', '720p', 'other']
export const KIND_ORDER: readonly Kind[] = ['movie', 'episode', 'track']

/** What SQLite binds for a `?`: better-sqlite3 refuses a boolean or undefined. */
export type Param = string | number | null

const isQuality = (label: string): label is Quality => Object.hasOwn(QUALITY_RANK, label)

// The probe's ladder as pairs, in the order it names them. Read off the
// constant rather than restated, for the reason NAMED_FILTERS gives below.
const LADDER: readonly (readonly [Quality, number])[] = Object.entries(QUALITY_RANK).flatMap(
  ([label, rank]) => (isQuality(label) ? [[label, rank] as const] : []),
)

const RANK_QUALITY: ReadonlyMap<number, Quality> = new Map(
  LADDER.map(([label, rank]) => [rank, label]),
)

type NamedFilter = Exclude<QualityFilter, 'other'>

// The buckets that name a quality, and the rank at or below which a row is
// "other" instead. Derived rather than written down: the probe's ladder is
// where a new tier is named, and a ladder and a hand-written CASE that
// disagree would put a play in a column the totals do not count it in.
const NAMED_FILTERS: readonly NamedFilter[] = QUALITY_FILTERS.filter(
  (quality): quality is NamedFilter => quality !== 'other',
)
export const OTHER_RANK_MAX = Math.min(...NAMED_FILTERS.map((quality) => QUALITY_RANK[quality])) - 1

/**
 * How a stored quality label ranks, as SQL, so a group can take its best
 * one. An unknown or absent label ranks below every named bucket.
 */
export const rankSql = (column: string): string => {
  const whens = LADDER.map(([label, rank]) => `WHEN '${label}' THEN ${rank}`).join(' ')
  return `CASE ${column} ${whens} ELSE 0 END`
}

/**
 * Which bucket a rank falls in, as SQL: the quality it names, or "other" for
 * anything below the lowest named one.
 */
export const filterSql = (rankColumn: string): string => {
  const whens = NAMED_FILTERS.map(
    (quality) => `WHEN ${QUALITY_RANK[quality]} THEN '${quality}'`,
  ).join(' ')
  return `CASE ${rankColumn} ${whens} ELSE 'other' END`
}

// The best title known for a play's item: the library's, then the ledger's
// own, then a placeholder. The ledger does record completions with a blank
// title (measured 2026-09-18: a hundred or so episodes across the fleet), and
// a blank must not become a group that ranks.
const ITEM_TITLE_SQL = "COALESCE(NULLIF(i.title, ''), NULLIF(p.title, ''), 'Untitled')"

// Every play joined to what is known about its item.
//
// An episode whose show is not known, or a track whose album is not, groups as
// itself rather than under its own title. Before this every unknown "Episode
// 1" from every unknown show landed in one row called "Episode 1", which was
// the top title on the fleet the first time real data was read. An item stands
// alone until its metadata arrives, and it says so in its context.
const BASE_SELECT = `
    SELECT p.host, p.history_id, p.rating_key, p.kind, p.account_id, p.device_id,
           p.section_id, p.viewed_at,
           ${ITEM_TITLE_SQL} AS item_title,
           i.parent_title, i.grandparent_title, i.parent_index, i.item_index, i.year,
           i.quality, i.duration_ms, i.thumb,
           CASE p.kind
             WHEN 'movie' THEN
               CASE WHEN COALESCE(NULLIF(i.title, ''), NULLIF(p.title, '')) IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'movie:' || lower(${ITEM_TITLE_SQL})
                                  || ':' || COALESCE(CAST(i.year AS TEXT), '')
               END
             WHEN 'episode' THEN
               CASE WHEN NULLIF(i.grandparent_title, '') IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'show:' || lower(i.grandparent_title)
               END
             ELSE
               CASE WHEN NULLIF(i.parent_title, '') IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'album:' || lower(i.parent_title)
                                  || ':' || lower(COALESCE(i.grandparent_title, ''))
               END
           END AS group_key,
           CASE p.kind
             WHEN 'movie' THEN ${ITEM_TITLE_SQL}
             WHEN 'episode' THEN COALESCE(NULLIF(i.grandparent_title, ''), ${ITEM_TITLE_SQL})
             ELSE COALESCE(NULLIF(i.parent_title, ''), ${ITEM_TITLE_SQL})
           END AS group_title,
           CASE p.kind
             WHEN 'episode' THEN
               CASE WHEN NULLIF(i.grandparent_title, '') IS NULL THEN 'show not known' END
             WHEN 'track' THEN
               CASE WHEN NULLIF(i.parent_title, '') IS NULL THEN 'album not known'
                    ELSE i.grandparent_title END
           END AS group_context,
           CASE p.kind WHEN 'movie' THEN i.year END AS group_year,
           ${rankSql('i.quality')} AS quality_rank
    FROM (
        SELECT *,
               LAG(viewed_at) OVER (
                   PARTITION BY host, rating_key, account_id
                   ORDER BY viewed_at, history_id
               ) AS prev_viewed_at
        FROM plex_plays
    ) p
    LEFT JOIN plex_items i ON i.host = p.host AND i.rating_key = p.rating_key
`

// A completion the same viewer logged against the same item on the same
// server, sooner after the previous one than the item runs for, is that
// previous viewing marked watched again, not a second viewing. The first row
// is the one kept: it is when the item became watched. An item whose runtime
// is not known (gone from the library, never described) keeps every row, since
// a guess would delete a play a viewer may really have made.
//
// The predecessor is the row before by time, kept or not, so a chain of
// markings inside one runtime collapses to its head. The one shape this
// misjudges is a real replay finished within a runtime of a dropped marking
// rather than of the kept head; it costs one rewatch and needs a viewer to
// restart an item the moment it ends.
const ONE_VIEWING_SQL =
  '(p.prev_viewed_at IS NULL OR i.duration_ms IS NULL ' +
  'OR (p.viewed_at - p.prev_viewed_at) * 1000 >= i.duration_ms)'

/**
 * What every view narrows by. `since` is an inclusive epoch floor, or null
 * for all time. A quality filter is a statement about video, so it excludes
 * tracks whichever bucket it names.
 */
export type Filters = Readonly<{
  since: number | null
  host: string | null
  kind: Kind | null
  quality: QualityFilter | null
}>

/** A Filters value, every field defaulting to null the way the dataclass did. */
export const filters = ({
  since = null,
  host = null,
  kind = null,
  quality = null,
}: {
  since?: number | null
  host?: string | null
  kind?: Kind | null
  quality?: QualityFilter | null
} = {}): Filters => ({ since, host, kind, quality })

/**
 * The WHERE line for however many clauses are live, empty ones dropped, and
 * nothing at all when none of them is.
 */
export const where = (...clauses: readonly string[]): string => {
  const live = clauses.filter((clause) => !!clause)
  return live.length > 0 ? `WHERE ${live.join(' AND ')}` : ''
}

type Clause = readonly [string, readonly Param[]]

/** The WHERE clauses one Filters value adds to the play/item join. */
export const conditions = (narrowing: Filters): readonly [readonly string[], readonly Param[]] => {
  const bySince: readonly Clause[] =
    narrowing.since === null ? [] : [['p.viewed_at >= ?', [narrowing.since]]]
  const byHost: readonly Clause[] =
    narrowing.host === null ? [] : [['p.host = ?', [narrowing.host]]]
  const byKind: readonly Clause[] =
    narrowing.kind === null ? [] : [['p.kind = ?', [narrowing.kind]]]
  const byQuality: readonly Clause[] =
    narrowing.quality === 'other'
      ? // sd and unknown video; a track has no video and is never "other"
        [[`p.kind != 'track' AND ${rankSql('i.quality')} <= ${OTHER_RANK_MAX}`, []]]
      : narrowing.quality === null
        ? []
        : [['i.quality = ?', [narrowing.quality]]]
  const clauses = [...bySince, ...byHost, ...byKind, ...byQuality]
  return [clauses.map(([sql]) => sql), clauses.flatMap(([, params]) => params)]
}

/**
 * Hold, for the life of `work`, the plays a request asked for: each play
 * joined to its item, narrowed by the filters, with a viewing Plex logged
 * twice counted once. Hands `work` the table's name and returns what it
 * returns.
 *
 * A table rather than a CTE because sqlite evaluates a CTE afresh in every
 * statement that names it, and a view makes five or six. The base runs a
 * LAG() window over the whole ledger, so naming it six times ran the window
 * six times, and the page reads it on every filter press. The table lives in
 * this connection only, which the session opened for this one request, and
 * it is dropped on the way out so a connection a test holds open stays
 * clean. A caller that opens a second one while this is held names it, so
 * the two cannot collide.
 */
export const baseTable = <T>({
  connection,
  filters: narrowing,
  extra = [],
  extraParams = [],
  table = 'base_now',
  work,
}: {
  connection: Connection
  filters: Filters
  extra?: readonly string[]
  extraParams?: readonly Param[]
  table?: string
  work: (table: string) => T
}): T => {
  const [clauses, params] = conditions(narrowing)
  const predicate = [...clauses, ...extra, ONE_VIEWING_SQL].join(' AND ')
  connection.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  connection
    .prepare(`CREATE TEMP TABLE ${table} AS ${BASE_SELECT} WHERE ${predicate}`)
    .run(...params, ...extraParams)
  try {
    return work(table)
  } finally {
    connection.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
}

/**
 * `dict(rows)` over a query of a text key and a count, read by position the
 * way Python's dict() reads a row, so a bare `COUNT(*)` needs no alias the
 * SQL does not have.
 */
export const counts = ({
  connection,
  sql,
  params = [],
}: {
  connection: Connection
  sql: string
  params?: readonly Param[]
}): ReadonlyMap<string, number> =>
  new Map(
    connection
      .prepare(sql)
      .raw(true)
      .all(...params)
      .map((row) => {
        const [key, count]: readonly unknown[] = Array.isArray(row) ? row : []
        if (typeof key !== 'string' || typeof count !== 'number') {
          throw new TypeError(`expected a (text, count) row from: ${sql.trim()}`)
        }
        return [key, count] as const
      }),
  )

export const utc = (epoch: number): Date => new Date(epoch * 1000)

/**
 * The same, for a column that may hold nothing: a title never played inside
 * the window, an item the library never dated.
 */
export const utcOrNone = (epoch: number | null): Date | null => (epoch === null ? null : utc(epoch))

export const stamp = (value: string | null): Date | null => (value ? parseIso(value) : null)

export const quality = (rank: number | null): Quality | null =>
  rank ? (RANK_QUALITY.get(rank) ?? null) : null

export const hosts = (concatenated: string | null): readonly string[] =>
  concatenated ? concatenated.split(',').toSorted() : []

// A stored kind or quality label is narrowed rather than cast. Only the
// parsers ever wrote these columns, so a value outside the set is a schema
// bug, and it throws the way a mistyped column does in rows.ts.

const isKind = (value: string): value is Kind => KINDS.has(value)

/** A stored kind, narrowed to the three the ledger holds. */
export const kindOf = (value: string): Kind => {
  if (!isKind(value)) {
    throw new TypeError(`not a play kind: ${value}`)
  }
  return value
}

/** A stored kind that may be absent, as a group read from no rows is. */
export const kindOrNull = (value: string | null): Kind | null =>
  value === null ? null : kindOf(value)

/** A stored quality label, narrowed to the ladder, or null when none is stored. */
export const qualityLabel = (value: string | null): Quality | null => {
  if (value === null) {
    return null
  }
  if (!isQuality(value)) {
    throw new TypeError(`not a quality label: ${value}`)
  }
  return value
}

/**
 * Names and avatars by account id, the first non-empty one across hosts.
 *
 * The owner is id 1 on every server and a shared user carries the same
 * plex.tv id everywhere, so one map serves the fleet. A server that lists an
 * account nameless does not blank a name another server knows.
 */
export const identities = (
  connection: Connection,
): readonly [ReadonlyMap<number, string>, ReadonlyMap<number, string>] => {
  const rows = asRows(
    connection
      .prepare('SELECT account_id, name, thumb FROM plex_accounts ORDER BY host, account_id')
      .all(),
  )
  const firstOf = (column: string): ReadonlyMap<number, string> =>
    rows.reduce((found, row) => {
      const accountId = fields(row).number('account_id')
      const value = fields(row).textOrNull(column)
      return value && !found.has(accountId) ? found.set(accountId, value) : found
    }, new Map<number, string>())
  return [firstOf('name'), firstOf('thumb')]
}

/**
 * A viewer nobody has named keeps their id: a play must never be dropped, or
 * shown under someone else's name, for want of one.
 */
export const name = ({
  names,
  accountId,
}: {
  names: ReadonlyMap<number, string>
  accountId: number
}): string => names.get(accountId) || `account ${accountId}`
