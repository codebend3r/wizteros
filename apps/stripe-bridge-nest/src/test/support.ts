import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared test plumbing, standing in for pytest's `tmp_path` and the recorded
// fixtures under src/test/fixtures.

const dirs: string[] = []

/** A path to a fresh, not yet created database file in its own temp directory. */
export const tempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-bridge-'))
  dirs.push(dir)
  return join(dir, 'bridge.db')
}

/** Remove every directory `tempDbPath` made. Call from an afterEach. */
export const removeTempDirs = (): void => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
}

/** A recorded fixture from src/test/fixtures, as text. */
export const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** A recorded JSON fixture, parsed to `unknown` for the caller to narrow. */
export const fixtureJson = (name: string): unknown => JSON.parse(fixtureText(name))
