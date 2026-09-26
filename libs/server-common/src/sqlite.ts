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

const BUSY_TIMEOUT_MS = 30_000

export const openSqlite = ({ path, wal = false }: SqliteFileOptions): SqliteDatabase => {
  const database = new Database(path, wal ? { timeout: BUSY_TIMEOUT_MS } : {})
  if (wal) {
    database.pragma('journal_mode = WAL')
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
  work,
}: SqliteFileOptions & { work: (database: SqliteDatabase) => T }): T => {
  const database = openSqlite({ path, wal })
  try {
    return database.transaction(() => work(database))()
  } finally {
    database.close()
  }
}
