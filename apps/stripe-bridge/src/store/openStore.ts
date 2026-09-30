import { type SqliteDatabase, withSqlite } from '@wizteros/server-common'
import { customerStore } from '@/store/customers.js'
import { eventStore } from '@/store/events.js'
import { inviteStore } from '@/store/invites.js'
import { overrideStore } from '@/store/overrides.js'
import { initSchema } from '@/store/schema.js'
import type { Units } from '@/store/units.js'

// The bridge's SQLite file (the customer map, the admin overrides, both logs
// and the invites it minted) as one port on the Bridge, beside Wizarr,
// Stripe, plex.tv and SMTP.

/** Every store operation, over whatever connection the units hand out. */
const operationsOver = (units: Units) => ({
  ...customerStore(units),
  ...overrideStore(units),
  ...eventStore(units),
  ...inviteStore(units),
})

export type StoreOperations = ReturnType<typeof operationsOver>

export type BridgeStore = StoreOperations &
  Readonly<{
    /**
     * Create the tables and backfill the added columns before anything reads
     * them; safe on every startup.
     */
    init: () => void
    /**
     * Run `work` against one connection in one write transaction, so the
     * writes it makes land together or not at all. `work` must be
     * synchronous: the transaction commits the moment it returns.
     */
    transaction: <T>(work: (store: StoreOperations) => T) => T
  }>

/** Both units on a single connection, for the operations inside one transaction. */
const unitsOn = (connection: SqliteDatabase): Units => ({
  read: (work) => work(connection),
  write: (work) => work(connection),
})

/**
 * The store over the SQLite file at `path`. Opening it touches nothing: each
 * operation opens its own connection for one transaction and closes it.
 */
export const openStore = (path: string): BridgeStore => ({
  ...operationsOver({
    read: (work) => withSqlite({ path, mode: 'read', work }),
    write: (work) => withSqlite({ path, work }),
  }),
  init: () => withSqlite({ path, work: (connection) => initSchema({ connection }) }),
  transaction: (work) =>
    withSqlite({ path, work: (connection) => work(operationsOver(unitsOn(connection))) }),
})
