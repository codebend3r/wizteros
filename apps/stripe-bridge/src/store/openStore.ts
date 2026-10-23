import { type SqliteDatabase, withSqlite } from '@wizteros/server-common'
import { customerStore } from '@/store/customers.js'
import { eventStore } from '@/store/events.js'
import { inviteStore } from '@/store/invites.js'
import { overrideStore } from '@/store/overrides.js'
import { initSchema } from '@/store/schema.js'
import type { Unit, Units } from '@/store/units.js'

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

/**
 * Both units over read-only connections to the file at `path`: a `write`
 * unit runs, and SQLite refuses its first write.
 */
export const readOnlyUnits = (path: string): Units => {
  const unit: Unit = (work) => withSqlite({ path, readonly: true, work })
  return { read: unit, write: unit }
}

/** The reads an operator's tooling may make; nothing that writes is in it. */
export type ReadOnlyStore = Pick<
  StoreOperations,
  | 'allCustomerRows'
  | 'customerRow'
  | 'customerIdsForEmail'
  | 'allMemberTags'
  | 'getMemberTag'
  | 'getMemberDownloads'
  | 'eventsForEmail'
  | 'allBaselineInvites'
>

/**
 * The store over the live file, for reading only. Every connection is opened
 * read-only, so even a write operation reached by mistake fails in SQLite,
 * and only the reads are handed out at all.
 */
export const openReadOnlyStore = (path: string): ReadOnlyStore => {
  const operations = operationsOver(readOnlyUnits(path))
  return {
    allCustomerRows: operations.allCustomerRows,
    customerRow: operations.customerRow,
    customerIdsForEmail: operations.customerIdsForEmail,
    allMemberTags: operations.allMemberTags,
    getMemberTag: operations.getMemberTag,
    getMemberDownloads: operations.getMemberDownloads,
    eventsForEmail: operations.eventsForEmail,
    allBaselineInvites: operations.allBaselineInvites,
  }
}
