import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection, type Connection } from '@/db.js'

// Shared test plumbing, standing in for the pytest fixtures: `tmp_path`, the
// `db_path` and `db` fixtures in conftest.py, and the recorded fixtures under
// src/test/fixtures.

const dirs: string[] = []

/** A path to a fresh, empty database file in its own temp directory. */
export const tempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-monitor-'))
  dirs.push(dir)
  return join(dir, 'fleet.db')
}

/** Remove every directory `tempDbPath` made. Call from an afterEach. */
export const removeTempDirs = (): void => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
}

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
export const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** A recorded JSON fixture, parsed to `unknown` for the caller to narrow. */
export const fixtureJson = (name: string): unknown => JSON.parse(fixtureText(name))
