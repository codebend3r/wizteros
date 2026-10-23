import { fixturesIn, tempFiles } from '@wizteros/server-common/testing'

// Shared test plumbing: throwaway database paths and the recorded fixtures
// under src/test/fixtures.

const temp = tempFiles({ prefix: 'stripe-bridge-', file: 'bridge.db' })
const fixtures = fixturesIn(new URL('./fixtures/', import.meta.url))

/** A path to a fresh, not yet created database file in its own temp directory. */
export const tempDbPath = temp.path

/** Remove every directory `tempDbPath` made. Call from an afterEach. */
export const removeTempDirs = temp.removeAll

/** A recorded fixture from src/test/fixtures, as text. */
export const fixtureText = fixtures.text

/** A recorded JSON fixture, parsed to `unknown` for the caller to narrow. */
export const fixtureJson = fixtures.json
