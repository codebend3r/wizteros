import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SqliteDatabase, withSqlite } from './sqlite.js'

const isCount = (row: unknown): row is { n: number } =>
  typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'

describe('withSqlite', () => {
  let dir = ''
  let path = ''

  const count = (): number =>
    withSqlite({
      path,
      work: (database) => {
        const row: unknown = database.prepare('SELECT COUNT(*) AS n FROM notes').get()
        return isCount(row) ? row.n : -1
      },
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'server-common-'))
    path = join(dir, 'test.db')
    withSqlite({
      path,
      work: (database) => database.exec('CREATE TABLE notes (body TEXT NOT NULL)'),
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('commits the unit of work when it returns', () => {
    withSqlite({
      path,
      work: (database) => database.prepare('INSERT INTO notes (body) VALUES (?)').run('kept'),
    })
    expect(count()).toBe(1)
  })

  it('rolls the whole unit of work back when it throws', () => {
    expect(() =>
      withSqlite({
        path,
        work: (database) => {
          database.prepare('INSERT INTO notes (body) VALUES (?)').run('first')
          database.prepare('INSERT INTO notes (body) VALUES (?)').run('second')
          throw new Error('boom')
        },
      }),
    ).toThrow('boom')
    expect(count()).toBe(0)
  })

  it('closes the connection whether the work returns or throws', () => {
    const opened: SqliteDatabase[] = []
    withSqlite({ path, work: (database) => opened.push(database) })
    expect(() =>
      withSqlite({
        path,
        work: (database) => {
          opened.push(database)
          throw new Error('boom')
        },
      }),
    ).toThrow('boom')
    expect(opened.map((database) => database.open)).toEqual([false, false])
  })

  it('returns what the work returns', () => {
    expect(withSqlite({ path, work: () => 'answer' })).toBe('answer')
  })

  it('leaves the default rollback journal alone unless WAL is asked for', () => {
    expect(
      withSqlite({ path, work: (database) => database.pragma('journal_mode', { simple: true }) }),
    ).toBe('delete')
  })

  it('opens in WAL mode with a 30 second busy timeout when asked', () => {
    const settings = withSqlite({
      path,
      wal: true,
      work: (database) => ({
        journal: database.pragma('journal_mode', { simple: true }),
        busyTimeout: database.pragma('busy_timeout', { simple: true }),
      }),
    })
    expect(settings).toEqual({ journal: 'wal', busyTimeout: 30_000 })
  })
})
