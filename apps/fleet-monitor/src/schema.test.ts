import { asRows, fields } from '@wizteros/server-common'
import { afterEach, describe, expect, it } from 'vitest'
import { session } from '@/db.js'
import { initDb } from '@/schema.js'
import { latest, prune, writeSamples } from '@/store.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

const T0 = new Date(Date.UTC(2026, 9, 19, 12, 0, 0))

// The shape a file written before the rollups and coverage were dropped still
// has: samples with a NOT NULL kind, the coverage mark, and both rollup tiers.
const LEGACY = [
  `CREATE TABLE samples (
     target TEXT NOT NULL, metric TEXT NOT NULL, at TEXT NOT NULL,
     value REAL NOT NULL, kind TEXT NOT NULL)`,
  `INSERT INTO samples VALUES ('host:syrax', 'load.1m', '2026-10-19T11:59:30+00:00', 0.5, 'gauge')`,
  'CREATE TABLE coverage (id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL)',
  "INSERT INTO coverage VALUES (1, '2026-10-01T00:00:00+00:00')",
  ...['rollup_5m', 'rollup_1h'].flatMap((table) => [
    `CREATE TABLE ${table} (
       target TEXT NOT NULL, metric TEXT NOT NULL, bucket TEXT NOT NULL,
       min_value REAL NOT NULL, max_value REAL NOT NULL, avg_value REAL NOT NULL,
       sample_count INTEGER NOT NULL, PRIMARY KEY (target, metric, bucket))`,
    `INSERT INTO ${table} VALUES ('host:syrax', 'load.1m', '2026-01-01T00:00:00+00:00', 1, 1, 1, 1)`,
  ]),
]

const tables = (path: string): readonly string[] =>
  session({
    path,
    mode: 'read',
    work: (connection) =>
      asRows(
        connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all(),
      ).map((row) => fields(row).text('name')),
  })

const rowsOf = (path: string, sql: string): readonly unknown[] =>
  session({ path, mode: 'read', work: (connection) => connection.prepare(sql).raw().all() })

describe('initDb', () => {
  afterEach(() => {
    removeTempDirs()
  })

  it('no longer creates the coverage or rollup tables in a fresh file', () => {
    const path = tempDbPath()
    initDb(path)

    expect(tables(path)).not.toContain('coverage')
    expect(tables(path)).not.toContain('rollup_5m')
    expect(tables(path)).not.toContain('rollup_1h')
    expect(rowsOf(path, "SELECT name FROM pragma_table_info('samples')")).toEqual([
      ['target'],
      ['metric'],
      ['at'],
      ['value'],
    ])
  })

  it('leaves the tables an older file holds untouched, and still writes into it', () => {
    // the live fleet.db is one of these: nothing is dropped or rewritten, the
    // dead tables simply stop being read and written
    const path = tempDbPath()
    session({ path, work: (connection) => LEGACY.forEach((sql) => connection.prepare(sql).run()) })

    initDb(path)
    session({
      path,
      work: (connection) => {
        writeSamples({
          connection,
          target: 'host:syrax',
          at: T0,
          samples: [{ metric: 'load.1m', value: 0.25 }],
        })
        prune({ connection, now: T0 })
      },
    })

    expect(rowsOf(path, 'SELECT * FROM coverage')).toEqual([[1, '2026-10-01T00:00:00+00:00']])
    expect(rowsOf(path, 'SELECT COUNT(*) FROM rollup_5m')).toEqual([[1]])
    expect(rowsOf(path, 'SELECT COUNT(*) FROM rollup_1h')).toEqual([[1]])
    expect(rowsOf(path, 'SELECT value, kind FROM samples ORDER BY at')).toEqual([
      [0.5, 'gauge'],
      [0.25, ''],
    ])
    expect(
      session({
        path,
        mode: 'read',
        work: (connection) =>
          latest({ connection, target: 'host:syrax', since: new Date(T0.getTime() - 60_000) }),
      }),
    ).toEqual({ 'load.1m': 0.25 })
  })
})
