import { fixturesIn, tempFiles } from '@wizteros/server-common/testing'
import { openConnection, type Connection } from '@/db.js'

// Shared test plumbing, standing in for the pytest fixtures: `tmp_path`, the
// `db_path` and `db` fixtures in conftest.py, and the recorded fixtures under
// src/test/fixtures.

const temp = tempFiles({ prefix: 'fleet-monitor-', file: 'fleet.db' })
const fixtures = fixturesIn(new URL('./fixtures/', import.meta.url))

/** A path to a fresh, empty database file in its own temp directory. */
export const tempDbPath = temp.path

/** Remove every directory `tempDbPath` made. Call from an afterEach. */
export const removeTempDirs = temp.removeAll

/**
 * One connection standing in for a single session across a whole test, like
 * the `db` fixture: pass the init functions the test needs, and close it in an
 * afterEach.
 */
export const openTestConnection = ({
  path = tempDbPath(),
  init = [],
}: {
  path?: string
  init?: readonly ((connection: Connection) => void)[]
} = {}): Connection => {
  const connection = openConnection(path)
  init.forEach((run) => run(connection))
  return connection
}

/** A recorded fixture from src/test/fixtures, as text. */
export const fixtureText = fixtures.text

/** A recorded JSON fixture, parsed to `unknown` for the caller to narrow. */
export const fixtureJson = fixtures.json
