import type { SqliteDatabase } from '@wizteros/server-common'

/** Run `work` against a connection and answer what it returned. */
export type Unit = <T>(work: (connection: SqliteDatabase) => T) => T

/**
 * How a store module reaches the database: `read` for a unit that never
 * writes, `write` for one that does. Over a path, each call is its own
 * connection and transaction; inside a transaction, both hand out the one
 * connection that transaction holds.
 */
export type Units = Readonly<{ read: Unit; write: Unit }>
