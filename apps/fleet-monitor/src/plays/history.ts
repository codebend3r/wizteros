// The three paged histories the plays page draws: one viewer's, the whole
// fleet's, and one title's. All three read one page row and drop the fields
// the page around them already names.

import type { Connection } from '@/db.js'
import * as base from '@/plays/base.js'
import type { Kind, Quality } from '@/probes/plex.js'
import { asRows, fields, type Row } from '@wizteros/server-common'

/**
 * One completed play anywhere in the fleet: the viewer's row with who
 * finished it beside it, since the page around it names nobody. The other two
 * histories draw this row with fields dropped.
 */
export type PlayHistoryRow = Readonly<{
  viewed_at: Date
  host: string
  kind: Kind
  account_id: number
  viewer: string
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

/** One of a viewer's own plays: the page names the viewer, so the row does not. */
export type HistoryRow = Omit<PlayHistoryRow, 'account_id' | 'viewer'>

/**
 * One completion of one item under a title, named by who finished it.
 *
 * `title` is the item, not the group: the episode, the track, the film. The
 * group's own name is on the page around it.
 */
export type TitleHistoryRow = Omit<
  PlayHistoryRow,
  'group_key' | 'parent_title' | 'grandparent_title'
>

export type HistoryPage = Readonly<{
  account_id: number
  name: string
  total: number
  page: number
  page_size: number
  rows: readonly HistoryRow[]
}>

export type PlayHistoryPage = Readonly<{
  total: number
  page: number
  page_size: number
  rows: readonly PlayHistoryRow[]
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

// Every column the histories draw, so all three read the same rows and each
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

/**
 * How many plays under the filters `where` keeps, and one page of them, read
 * from one base table. `where` and its `params` speak of the table as `b`.
 */
const pagedPlays = ({
  connection,
  filters,
  where = '',
  params = [],
  page,
  pageSize,
}: {
  connection: Connection
  filters: base.Filters
  where?: string
  params?: readonly base.Param[]
  page: number
  pageSize: number
}): readonly [number, readonly Row[]] =>
  base.baseTable({
    connection,
    filters,
    work: (table) => {
      const counted = base.aggregateRow(
        connection.prepare(`SELECT COUNT(*) AS total FROM ${table} b ${where}`).get(...params),
      )
      return [
        counted.number('total'),
        pageOfPlays({ connection, table, where, params, page, pageSize }),
      ] as const
    },
  })

/** One page row, read whole: every field any of the three histories draws. */
const historyRow = ({
  row,
  names,
}: {
  row: Row
  names: ReadonlyMap<number, string>
}): PlayHistoryRow => {
  const column = fields(row)
  const accountId = column.number('account_id')
  return {
    viewed_at: base.utc(column.number('viewed_at')),
    host: column.text('host'),
    kind: base.kindOf(column.text('kind')),
    account_id: accountId,
    viewer: base.name({ names, accountId }),
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
}

// The row a viewer's own page draws: the page names them, so the row does not.
const viewerRow = ({ account_id: _id, viewer: _viewer, ...row }: PlayHistoryRow): HistoryRow => row

// The row a title's page draws: the page names the group, so the row names
// only the item.
const itemRow = ({
  group_key: _key,
  parent_title: _parent,
  grandparent_title: _grandparent,
  ...row
}: PlayHistoryRow): TitleHistoryRow => row

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
  const [total, rows] = pagedPlays({
    connection,
    filters,
    where: 'WHERE b.account_id = ?',
    params: [accountId],
    page,
    pageSize,
  })
  const [names] = base.identities(connection)
  return {
    account_id: accountId,
    name: base.name({ names, accountId }),
    total,
    page,
    page_size: pageSize,
    rows: rows.map((row) => viewerRow(historyRow({ row, names }))),
  }
}

/** Every completed play under the filters, newest first, one page at a time. */
export const playHistory = ({
  connection,
  filters,
  page,
  pageSize,
}: {
  connection: Connection
  filters: base.Filters
  page: number
  pageSize: number
}): PlayHistoryPage => {
  const [total, rows] = pagedPlays({ connection, filters, page, pageSize })
  const [names] = base.identities(connection)
  return {
    total,
    page,
    page_size: pageSize,
    rows: rows.map((row) => historyRow({ row, names })),
  }
}

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
  const [summary, windowed, names, rows] = base.baseTable({
    connection,
    filters,
    work: (table) => {
      const scoped = base.aggregateRow(
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
      const inWindow: Identity = {
        kind: scoped.textOrNull('kind'),
        title: scoped.textOrNull('title'),
        context: scoped.textOrNull('context'),
        year: scoped.numberOrNull('year'),
        quality_rank: scoped.numberOrNull('quality_rank'),
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
      return [scoped, inWindow, known, pageRows] as const
    },
  })

  // Nothing under the filters: name the title from its most recent play in
  // the ledger at large, so a title stays named under a filter that holds
  // none of its plays. The page has only the key, and an unnamed heading
  // would read as a title that had been deleted rather than one nobody
  // watched this month.
  const named = windowed.kind === null ? base.newestPlayOf({ connection, key }) : null
  const identity: Identity =
    named === null
      ? windowed
      : {
          kind: fields(named).textOrNull('kind'),
          title: fields(named).textOrNull('group_title'),
          context: fields(named).textOrNull('group_context'),
          year: fields(named).numberOrNull('group_year'),
          quality_rank: fields(named).numberOrNull('quality_rank'),
        }

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
    rows: rows.map((row) => itemRow(historyRow({ row, names }))),
  }
}
