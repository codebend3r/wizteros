import { openSqlite, type SqliteDatabase, withSqlite } from '@wizteros/server-common'

// Compaction runs beside the ticks, and the API and the collector are two
// processes on one file, so two writers can genuinely overlap. WAL keeps
// readers out of the way and the 30 second busy timeout makes a writer wait
// for another rather than fail: the loser is a 30 second tick, and losing it
// entirely is far worse than delaying it.

export type Connection = SqliteDatabase

/**
 * One connection for one unit of work: committed on success, rolled back on a
 * throw, and always closed.
 *
 * Every store, incidents and rollups call takes the connection rather than the
 * path, and this is the only way to get one. That is what makes a unit of
 * work atomic: a tick's samples and the check derived from them commit
 * together or not at all.
 */
export const session = <T>({
  path,
  work,
}: {
  path: string
  work: (connection: Connection) => T
}): T => withSqlite({ path, wal: true, work })

/**
 * A long-lived connection in the same mode, for a test that stands in for a
 * single session across several calls. The caller closes it.
 */
export const openConnection = (path: string): Connection => openSqlite({ path, wal: true })
