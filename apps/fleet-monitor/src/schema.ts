import { session } from '@/db.js'
import * as incidents from '@/incidents.js'
import * as plays from '@/plays/index.js'
import * as store from '@/store.js'

/**
 * Create every table either process reads or writes. Idempotent,
 * order-independent.
 *
 * One setup for everything that can be first to open a fresh FM_DB_PATH: the
 * API, the vitals loop and the play-history loop. Each of them used to create
 * its own subset, so a file the history loop opened alone held no samples
 * table, and the API that read one would answer its first /fleet with a 500.
 *
 * Kept apart from the collector so the API, which only needs the tables to
 * exist, does not load ssh, every probe and the Plex loop to get them.
 */
export const initDb = (path: string): void => {
  session({
    path,
    work: (connection) => {
      store.initDb(connection)
      incidents.initDb(connection)
      plays.initDb(connection)
    },
  })
}
