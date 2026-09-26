// The ledger itself: the schema, every write, and the cursors and status a
// sync pass reads back.
//
// Every function takes a connection, so a pass's page of plays commits with
// its cursor or neither does.

import type { Host } from '@/config.js'
import type { Connection } from '@/db.js'
import * as base from '@/plays/base.js'
import type { Account, Device, MediaItem, PlayEntry, Section, ServerInfo } from '@/probes/plex.js'
import { asRow, asRows, fields, flag, type Row } from '@/rows.js'
import { isoformat } from '@/time.js'

const SERVERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_servers (
    host              TEXT PRIMARY KEY,
    friendly_name     TEXT,
    machine_id        TEXT,
    version           TEXT,
    history_cursor    INTEGER,
    history_synced_at TEXT,
    history_ok        INTEGER NOT NULL DEFAULT 0,
    library_synced_at TEXT,
    library_ok        INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT
)
`

const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_accounts (
    host       TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    thumb      TEXT,
    PRIMARY KEY (host, account_id)
)
`

const DEVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_devices (
    host              TEXT NOT NULL,
    device_id         INTEGER NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    platform          TEXT,
    client_identifier TEXT,
    PRIMARY KEY (host, device_id)
)
`

const SECTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_sections (
    host       TEXT NOT NULL,
    section_id TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    excluded   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, section_id)
)
`

const ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_items (
    host                   TEXT NOT NULL,
    rating_key             TEXT NOT NULL,
    kind                   TEXT NOT NULL,
    title                  TEXT NOT NULL DEFAULT '',
    parent_rating_key      TEXT,
    parent_title           TEXT,
    parent_index           INTEGER,
    grandparent_rating_key TEXT,
    grandparent_title      TEXT,
    item_index             INTEGER,
    year                   INTEGER,
    section_id             TEXT,
    duration_ms            INTEGER,
    video_resolution       TEXT,
    width                  INTEGER,
    height                 INTEGER,
    quality                TEXT,
    thumb                  TEXT,
    added_at               INTEGER,
    present                INTEGER NOT NULL DEFAULT 1,
    seen_at                TEXT NOT NULL,
    PRIMARY KEY (host, rating_key)
)
`

const PLAYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS plex_plays (
    host       TEXT NOT NULL,
    history_id INTEGER NOT NULL,
    rating_key TEXT NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    section_id TEXT,
    account_id INTEGER NOT NULL,
    device_id  INTEGER,
    viewed_at  INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'history',
    PRIMARY KEY (host, history_id)
)
`

const INDEXES: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS ix_plex_plays_viewed ON plex_plays (viewed_at)',
  'CREATE INDEX IF NOT EXISTS ix_plex_plays_item ON plex_plays (host, rating_key)',
  'CREATE INDEX IF NOT EXISTS ix_plex_plays_account ON plex_plays (account_id)',
  'CREATE INDEX IF NOT EXISTS ix_plex_items_kind ON plex_items (host, kind, present)',
]

/** What one purge of the excluded libraries removed. */
export type Purged = Readonly<{
  plays: number
  items: number
}>

export type ServerStatus = Readonly<{
  host: string
  friendly_name: string | null
  plex_url: string
  reachable: boolean
  history_synced_at: Date | null
  library_synced_at: Date | null
  history_since: Date | null
  plays: number
  items: number
  last_error: string | null
}>

/**
 * Every table this module writes, and the one column a database written
 * before the exclusion rule existed does not have. CREATE TABLE IF NOT EXISTS
 * never widens an existing table, so the column is added by hand or every
 * section read answers "no such column". Nothing is excluded by the backfill:
 * the next inventory pass says which sections are.
 */
export const initDb = (connection: Connection): void => {
  const statements = [
    SERVERS_SCHEMA,
    ACCOUNTS_SCHEMA,
    DEVICES_SCHEMA,
    SECTIONS_SCHEMA,
    ITEMS_SCHEMA,
    PLAYS_SCHEMA,
    ...INDEXES,
  ]
  statements.forEach((statement) => connection.prepare(statement).run())
  const columns = new Set(
    asRows(connection.prepare('PRAGMA table_info(plex_sections)').all()).map((row) =>
      fields(row).text('name'),
    ),
  )
  if (!columns.has('excluded')) {
    connection
      .prepare('ALTER TABLE plex_sections ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0')
      .run()
  }
}

/**
 * Who the server says it is. Leaves the cursor and the sync marks alone: a
 * server re-identifying itself has not re-read its history.
 */
export const upsertServer = ({
  connection,
  host,
  info,
}: {
  connection: Connection
  host: string
  info: ServerInfo
}): void => {
  connection
    .prepare(
      `
        INSERT INTO plex_servers (host, friendly_name, machine_id, version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            friendly_name = excluded.friendly_name,
            machine_id = excluded.machine_id,
            version = excluded.version
        `,
    )
    .run(host, info.friendly_name, info.machine_id, info.version)
}

/**
 * The outcome of one history pass. Creates the row when the server has never
 * been identified, so a pass that failed at the first request is still visible
 * on /plays/sync rather than being a host with no row at all.
 */
export const markHistory = ({
  connection,
  host,
  at,
  ok,
  error,
}: {
  connection: Connection
  host: string
  at: Date
  ok: boolean
  error: string | null
}): void => {
  connection
    .prepare(
      `
        INSERT INTO plex_servers (host, history_synced_at, history_ok, last_error)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            history_synced_at = excluded.history_synced_at,
            history_ok = excluded.history_ok,
            last_error = excluded.last_error
        `,
    )
    .run(host, isoformat(at), flag(ok), error)
}

/**
 * The outcome of one inventory pass. A failure names itself in last_error; a
 * success leaves whatever the history pass last said.
 */
export const markLibrary = ({
  connection,
  host,
  at,
  ok,
  error,
}: {
  connection: Connection
  host: string
  at: Date
  ok: boolean
  error: string | null
}): void => {
  connection
    .prepare(
      `
        INSERT INTO plex_servers (host, library_synced_at, library_ok, last_error)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            library_synced_at = excluded.library_synced_at,
            library_ok = excluded.library_ok,
            last_error = COALESCE(excluded.last_error, plex_servers.last_error)
        `,
    )
    .run(host, isoformat(at), flag(ok), error)
}

/**
 * The newest viewedAt a pass has stored. Advanced per page, so a pass that
 * dies mid-backfill resumes from the last page that committed.
 */
export const setHistoryCursor = ({
  connection,
  host,
  cursor,
}: {
  connection: Connection
  host: string
  cursor: number
}): void => {
  connection
    .prepare(
      `
        INSERT INTO plex_servers (host, history_cursor) VALUES (?, ?)
        ON CONFLICT(host) DO UPDATE SET history_cursor = excluded.history_cursor
        `,
    )
    .run(host, cursor)
}

export const historyCursor = ({
  connection,
  host,
}: {
  connection: Connection
  host: string
}): number | null => {
  const row = asRow(
    connection.prepare('SELECT history_cursor FROM plex_servers WHERE host = ?').get(host),
  )
  return row === null ? null : fields(row).numberOrNull('history_cursor')
}

export const upsertAccounts = ({
  connection,
  host,
  accounts,
}: {
  connection: Connection
  host: string
  accounts: readonly Account[]
}): void => {
  const statement = connection.prepare(
    `
        INSERT INTO plex_accounts (host, account_id, name, thumb) VALUES (?, ?, ?, ?)
        ON CONFLICT(host, account_id) DO UPDATE SET
            name = excluded.name, thumb = excluded.thumb
        `,
  )
  accounts.forEach((a) => statement.run(host, a.account_id, a.name, a.thumb))
}

export const upsertDevices = ({
  connection,
  host,
  devices,
}: {
  connection: Connection
  host: string
  devices: readonly Device[]
}): void => {
  const statement = connection.prepare(
    `
        INSERT INTO plex_devices (host, device_id, name, platform, client_identifier)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host, device_id) DO UPDATE SET
            name = excluded.name,
            platform = excluded.platform,
            client_identifier = excluded.client_identifier
        `,
  )
  devices.forEach((d) => statement.run(host, d.device_id, d.name, d.platform, d.client_identifier))
}

/**
 * The libraries this server holds, each carrying whether the play page counts
 * it. The flag is stored rather than recomputed per query because the history
 * pass has to drop a play before it lands, and it reads the store, not the
 * server's section listing.
 */
export const upsertSections = ({
  connection,
  host,
  sections,
  excludedIds = [],
}: {
  connection: Connection
  host: string
  sections: readonly Section[]
  excludedIds?: Iterable<string>
}): void => {
  const excluded: ReadonlySet<string> = new Set(excludedIds)
  const statement = connection.prepare(
    `
        INSERT INTO plex_sections (host, section_id, title, kind, excluded)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host, section_id) DO UPDATE SET
            title = excluded.title, kind = excluded.kind, excluded = excluded.excluded
        `,
  )
  sections.forEach((s) =>
    statement.run(host, s.section_id, s.title, s.kind, flag(excluded.has(s.section_id))),
  )
}

/**
 * The sections on this host the page leaves out, as the last inventory pass
 * marked them. Empty until one has run, which is the safe direction: a play
 * kept for one round is purged by that pass, a play dropped in error is gone
 * for good.
 */
export const excludedSectionIds = ({
  connection,
  host,
}: {
  connection: Connection
  host: string
}): ReadonlySet<string> => {
  const rows = asRows(
    connection
      .prepare('SELECT section_id FROM plex_sections WHERE host = ? AND excluded = 1')
      .all(host),
  )
  return new Set(rows.map((row) => fields(row).text('section_id')))
}

/**
 * Delete every play and item belonging to these sections. Returns how many of
 * each went.
 *
 * Plays first, by their own section and by their item's: the ledger names the
 * section on most rows, but a row that does not carries the item that does,
 * and an excluded library must not survive on the technicality.
 */
export const purgeSections = ({
  connection,
  host,
  sectionIds,
}: {
  connection: Connection
  host: string
  sectionIds: Iterable<string>
}): Purged => {
  const ids = [...sectionIds]
  if (ids.length === 0) {
    return { plays: 0, items: 0 }
  }
  const marks = ids.map(() => '?').join(', ')
  const playsGone = connection
    .prepare(
      `
        DELETE FROM plex_plays
        WHERE host = ? AND (
            section_id IN (${marks})
            OR rating_key IN (
                SELECT rating_key FROM plex_items
                WHERE host = ? AND section_id IN (${marks})
            )
        )
        `,
    )
    .run(host, ...ids, host, ...ids).changes
  const itemsGone = connection
    .prepare(`DELETE FROM plex_items WHERE host = ? AND section_id IN (${marks})`)
    .run(host, ...ids).changes
  return { plays: playsGone, items: itemsGone }
}

/**
 * Items as the server describes them now. An item seen again is present
 * again, whatever a retire pass said before: the inventory is the authority
 * on what is in the library.
 */
export const upsertItems = ({
  connection,
  host,
  items,
  seenAt,
}: {
  connection: Connection
  host: string
  items: readonly MediaItem[]
  seenAt: Date
}): void => {
  const statement = connection.prepare(
    `
        INSERT INTO plex_items (
            host, rating_key, kind, title, parent_rating_key, parent_title, parent_index,
            grandparent_rating_key, grandparent_title, item_index, year, section_id,
            duration_ms, video_resolution, width, height, quality, thumb, added_at,
            present, seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(host, rating_key) DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            parent_rating_key = excluded.parent_rating_key,
            parent_title = excluded.parent_title,
            parent_index = excluded.parent_index,
            grandparent_rating_key = excluded.grandparent_rating_key,
            grandparent_title = excluded.grandparent_title,
            item_index = excluded.item_index,
            year = excluded.year,
            section_id = excluded.section_id,
            duration_ms = excluded.duration_ms,
            video_resolution = excluded.video_resolution,
            width = excluded.width,
            height = excluded.height,
            quality = excluded.quality,
            thumb = excluded.thumb,
            added_at = excluded.added_at,
            present = 1,
            seen_at = excluded.seen_at
        `,
  )
  const seen = isoformat(seenAt)
  items.forEach((item) =>
    statement.run(
      host,
      item.rating_key,
      item.kind,
      item.title,
      item.parent_rating_key,
      item.parent_title,
      item.parent_index,
      item.grandparent_rating_key,
      item.grandparent_title,
      item.index,
      item.year,
      item.section_id,
      item.duration_ms,
      item.video_resolution,
      item.width,
      item.height,
      item.quality,
      item.thumb,
      item.added_at,
      seen,
    ),
  )
}

/**
 * A row for every played item the server no longer answers for.
 *
 * Absent, not present: the play keeps its own title and no quality, and the
 * key stops being asked for on every pass. Should the item come back, the
 * inventory's upsert overwrites the stub and marks it present again.
 */
export const stubMissingItems = ({
  connection,
  host,
  keys,
  seenAt,
}: {
  connection: Connection
  host: string
  keys: readonly string[]
  seenAt: Date
}): void => {
  if (keys.length === 0) {
    return
  }
  const marks = keys.map(() => '?').join(', ')
  connection
    .prepare(
      `
        INSERT OR IGNORE INTO plex_items (host, rating_key, kind, title, present, seen_at)
        SELECT host, rating_key, MIN(kind), MIN(title), 0, ?
        FROM plex_plays
        WHERE host = ? AND rating_key IN (${marks})
        GROUP BY host, rating_key
        `,
    )
    .run(isoformat(seenAt), host, ...keys)
}

/**
 * Mark absent every item a complete inventory run did not see. Returns how
 * many. Only a run that paged every section to its end may call this: a run
 * that failed mid-section would otherwise retire the whole library behind the
 * failure.
 */
export const retireUnseenItems = ({
  connection,
  host,
  seenBefore,
}: {
  connection: Connection
  host: string
  seenBefore: Date
}): number =>
  connection
    .prepare('UPDATE plex_items SET present = 0 WHERE host = ? AND present = 1 AND seen_at < ?')
    .run(host, isoformat(seenBefore)).changes

/**
 * Insert what is new, ignore what is already there. Returns how many were
 * new. Idempotent on the server's own history id, which is what makes the
 * overlap re-read and the resume-after-crash free.
 *
 * Python read the difference in `total_changes` around an executemany;
 * better-sqlite3 reports each run's own changes, which for an INSERT OR
 * IGNORE is 1 for a new row and 0 for one already there, so their sum is the
 * same count.
 */
export const insertPlays = ({
  connection,
  host,
  plays,
}: {
  connection: Connection
  host: string
  plays: readonly PlayEntry[]
}): number => {
  if (plays.length === 0) {
    return 0
  }
  const statement = connection.prepare(
    `
        INSERT OR IGNORE INTO plex_plays (
            host, history_id, rating_key, kind, title, section_id, account_id, device_id,
            viewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
  )
  return plays.reduce(
    (inserted, play) =>
      inserted +
      statement.run(
        host,
        play.history_id,
        play.rating_key,
        play.kind,
        play.title,
        play.section_id,
        play.account_id,
        play.device_id,
        play.viewed_at,
      ).changes,
    0,
  )
}

/**
 * Played items on this host with no item row at all: what the next enrichment
 * batch asks the server about.
 */
export const missingItemKeys = ({
  connection,
  host,
  limit,
}: {
  connection: Connection
  host: string
  limit: number
}): readonly string[] =>
  asRows(
    connection
      .prepare(
        `
        SELECT DISTINCT p.rating_key
        FROM plex_plays p
        LEFT JOIN plex_items i ON i.host = p.host AND i.rating_key = p.rating_key
        WHERE p.host = ? AND i.rating_key IS NULL
        ORDER BY p.rating_key
        LIMIT ?
        `,
      )
      .all(host, limit),
  ).map((row) => fields(row).text('rating_key'))

/** The oldest stored viewedAt, fleet-wide or for one host. */
export const earliestPlay = ({
  connection,
  host,
}: {
  connection: Connection
  host: string | null
}): number | null => {
  const row =
    host === null
      ? asRow(connection.prepare('SELECT MIN(viewed_at) AS at FROM plex_plays').get())
      : asRow(
          connection
            .prepare('SELECT MIN(viewed_at) AS at FROM plex_plays WHERE host = ?')
            .get(host),
        )
  return row === null ? null : fields(row).numberOrNull('at')
}

/**
 * One line per Plex host handed in, whether or not a pass has ever reached
 * it. A host with no row is listed unreachable and empty rather than left
 * out: absence from the page would read as absence from the fleet.
 */
export const syncStatus = ({
  connection,
  hosts,
}: {
  connection: Connection
  hosts: readonly Host[]
}): readonly ServerStatus[] => {
  const servers: ReadonlyMap<string, Row> = new Map(
    asRows(
      connection
        .prepare(
          `
            SELECT host, friendly_name, history_synced_at, history_ok, library_synced_at,
                   last_error
            FROM plex_servers
            `,
        )
        .all(),
    ).map((row) => [fields(row).text('host'), row] as const),
  )
  // through the same base every view reads, so the count on the sync line
  // is the count the overview totals to, not the ledger's raw row count
  const plays = base.baseTable({
    connection,
    filters: base.filters(),
    work: (table): ReadonlyMap<string, readonly [number, number | null]> =>
      new Map(
        asRows(
          connection
            .prepare(
              `
                SELECT host, COUNT(*) AS plays, MIN(viewed_at) AS since
                FROM ${table}
                GROUP BY host
                `,
            )
            .all(),
        ).map(
          (row) =>
            [
              fields(row).text('host'),
              [fields(row).number('plays'), fields(row).numberOrNull('since')],
            ] as const,
        ),
      ),
  })
  const items = base.counts({
    connection,
    sql: 'SELECT host, COUNT(*) FROM plex_items WHERE present = 1 GROUP BY host',
  })
  return hosts.map((host) => status({ host, server: servers.get(host.name) ?? null, plays, items }))
}

/** One host's line, from the three reads above. */
const status = ({
  host,
  server,
  plays,
  items,
}: {
  host: Host
  server: Row | null
  plays: ReadonlyMap<string, readonly [number, number | null]>
  items: ReadonlyMap<string, number>
}): ServerStatus => {
  const [count, since] = plays.get(host.name) ?? [0, null]
  const known = server === null ? null : fields(server)
  return {
    host: host.name,
    friendly_name: known === null ? null : known.textOrNull('friendly_name'),
    plex_url: host.plex_url,
    reachable: known === null ? false : !!known.number('history_ok'),
    history_synced_at: known === null ? null : base.stamp(known.textOrNull('history_synced_at')),
    library_synced_at: known === null ? null : base.stamp(known.textOrNull('library_synced_at')),
    history_since: base.utcOrNone(since),
    plays: count,
    items: items.get(host.name) ?? 0,
    last_error: known === null ? null : known.textOrNull('last_error'),
  }
}
