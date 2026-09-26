import Database from 'better-sqlite3'

// The one way either server opens its SQLite file. Both Python services held
// to the same rule, a connection per unit of work that commits on success and
// is always closed, and this keeps it in one place so no module grows its own
// way to open the file again.

export type SqliteDatabase = Database.Database

export type SqliteFileOptions = {
  /** The SQLite file. It is created when missing. */
  path: string
  /**
   * WAL plus a 30 second busy timeout, for a file two processes write at
   * once. Readers never block the writer, and a writer that meets another
   * waits for it rather than failing: losing a unit of work is worse than
   * delaying it.
   */
  wal?: boolean
}

/**
 * How a unit of work takes its transaction.
 *
 * `write`, the default, begins IMMEDIATE: the write lock is taken up front, so
 * a unit that meets another writer waits out the busy timeout at its first
 * statement. A DEFERRED unit that reads and then writes cannot wait: if
 * another connection commits in between, WAL refuses to upgrade its stale
 * snapshot and the write fails at once with SQLITE_BUSY_SNAPSHOT. Python's
 * sqlite3 never met that, because it only began the transaction at the first
 * INSERT or UPDATE.
 *
 * `read` begins DEFERRED, for a unit that never writes the main database
 * (a temp table is fine). It sees one consistent snapshot and never makes a
 * writer wait.
 */
export type SqliteMode = 'write' | 'read'

const BUSY_TIMEOUT_MS = 30_000

export const openSqlite = ({ path, wal = false }: SqliteFileOptions): SqliteDatabase => {
  const database = new Database(path, wal ? { timeout: BUSY_TIMEOUT_MS } : {})
  if (wal) {
    try {
      // The first switch of a file to WAL needs an exclusive lock and can fail
      // on a busy or read-only file; the handle must not outlive the failure.
      database.pragma('journal_mode = WAL')
    } catch (error) {
      database.close()
      throw error
    }
  }
  return database
}

/**
 * Run `work` inside one transaction on a fresh connection: committed when it
 * returns, rolled back when it throws, and closed either way.
 *
 * `work` must be synchronous. better-sqlite3 commits the moment the function
 * returns, so a promise would escape the transaction.
 */
export const withSqlite = <T>({
  path,
  wal,
  mode = 'write',
  work,
}: SqliteFileOptions & { mode?: SqliteMode; work: (database: SqliteDatabase) => T }): T => {
  const database = openSqlite({ path, wal })
  try {
    const transaction = database.transaction(() => work(database))
    return mode === 'write' ? transaction.immediate() : transaction.deferred()
  } finally {
    database.close()
  }
}
