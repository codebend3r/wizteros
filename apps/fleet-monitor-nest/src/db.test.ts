import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openSqlite, withSqlite } from '@wizteros/server-common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetController, HealthController } from '@/api/fleetController.js'
import { PlaysController } from '@/api/playsController.js'
import { initDb } from '@/collector.js'
import * as config from '@/config.js'
import { type Connection, openConnection, session } from '@/db.js'
import { checkResult, initDb as initIncidents, observedRun, record } from '@/incidents.js'
import { compact, initDb as initRollups, read, RESOLUTIONS } from '@/rollups.js'
import { asRow, fields } from '@/rows.js'
import { initDb as initStore, lastHeartbeat, writeHeartbeat, writeSamples } from '@/store.js'
import { openTestConnection, removeTempDirs, tempDbPath } from '@/test/support.js'
import { addSeconds, isoformat } from '@/time.js'
import { CAPTURE_FACTOR } from '@/transport/ssh.js'

// Every connection the app opens goes through one of these two: a session
// through withSqlite, a long-lived connection through openSqlite. Both still
// do the real work; the spies only count, standing in for the Python test's
// patched sqlite3.connect. withSqlite reaches openSqlite from inside the lib,
// past the spy, so a session is counted once.
vi.mock('@wizteros/server-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wizteros/server-common')>()
  return { ...actual, openSqlite: vi.fn(actual.openSqlite), withSqlite: vi.fn(actual.withSqlite) }
})

const countConnections = (): void => {
  vi.mocked(openSqlite).mockClear()
  vi.mocked(withSqlite).mockClear()
}

const connectionsOpened = (): number =>
  vi.mocked(openSqlite).mock.calls.length + vi.mocked(withSqlite).mock.calls.length

const T0 = new Date(Date.UTC(2026, 7, 10, 12, 0, 0))

/** T0 moved by a number of seconds, the `T0 + timedelta(...)` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

// A second process standing in for a compaction that holds the write lock:
// the API and the collector are two processes on one file, and a thread in
// this one could not hold a lock while the test blocks in SQLite's busy wait.
// It takes the lock the way a write session does (BEGIN IMMEDIATE), writes
// the heartbeat as the Python holder did, says so, holds it for half a
// second, and commits. node:sqlite is only the holder's driver; the file
// locks are the OS's, so the two SQLite copies see each other across the
// process boundary.
const HOLD_THE_WRITE_LOCK = `
const { DatabaseSync } = require('node:sqlite')
const [path, at] = process.argv.slice(1)
const connection = new DatabaseSync(path)
connection.exec('BEGIN IMMEDIATE')
connection
  .prepare('INSERT INTO heartbeat (id, at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at')
  .run(at)
process.stdout.write('holding\\n')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
connection.exec('COMMIT')
connection.close()
`

/** A count from `SELECT COUNT(*) AS n`, read through a row rather than cast. */
const countOf = (row: unknown): number => fields(asRow(row) ?? {}).number('n')

describe('db', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  it('commits a session on success and closes it', () => {
    const path = tempDbPath()
    session({
      path,
      work: (connection) => {
        initStore(connection)
        writeHeartbeat({ connection, at: T0 })
      },
    })

    // a second, independent session sees it, so the first really committed
    const { closed, heartbeat } = session({
      path,
      work: (connection) => ({ closed: connection, heartbeat: lastHeartbeat(connection) }),
    })
    expect(heartbeat).toEqual(T0)

    // better-sqlite3's answer to a closed handle, where sqlite3 raised
    // ProgrammingError
    expect(() => closed.prepare('SELECT 1')).toThrow(TypeError)
  })

  it('rolls a session back and still closes it', () => {
    const path = tempDbPath()
    session({ path, work: initStore })

    const opened: Connection[] = []
    expect(() =>
      session({
        path,
        work: (connection) => {
          opened.push(connection)
          writeHeartbeat({ connection, at: T0 })
          throw new Error('the round died halfway')
        },
      }),
    ).toThrow('the round died halfway')

    // the whole unit of work is undone: a round that died leaves no half-state
    expect(session({ path, work: lastHeartbeat })).toBeNull()
    expect(opened.map((connection) => connection.open)).toEqual([false])
  })

  it('opens one connection for one fleet response', () => {
    // it used to open three per host plus two, so five hosts cost seventeen
    const path = tempDbPath()
    initDb(path)
    vi.stubEnv('FM_DB_PATH', path)
    session({ path, work: (connection) => writeHeartbeat({ connection, at: T0 }) })

    countConnections()
    new FleetController().fleet()

    expect(connectionsOpened()).toBe(1)
  })

  it('opens one connection for every other response too', () => {
    // Not in the Python suite, which pinned /fleet alone: every route answers
    // through exactly one session, as each Python handler opened one. The
    // handlers are called directly, as the Python test called api.fleet();
    // the gate and the query pipe in front of them open nothing.
    const path = tempDbPath()
    initDb(path)
    vi.stubEnv('FM_DB_PATH', path)
    const health = new HealthController()
    const fleet = new FleetController()
    const plays = new PlaysController()
    const paging = { days: 365, page: 1, page_size: 50 }
    const responses: readonly (readonly [string, () => unknown])[] = [
      ['/health', () => health.health()],
      ['/fleet/cpu', () => fleet.cpu({ minutes: 60 })],
      ['/fleet/memory', () => fleet.memory({ minutes: 60 })],
      ['/fleet/gpu', () => fleet.gpu({ minutes: 60 })],
      ['/fleet/network', () => fleet.network({ minutes: 60 })],
      ['/incidents', () => fleet.incidents({ hours: 24 })],
      ['/plays/overview', () => plays.overview({ days: 365 })],
      ['/plays/users', () => plays.users({ days: 365 })],
      ['/plays/users/1/history', () => plays.userHistory(1, paging)],
      ['/plays/title', () => plays.titleHistory({ ...paging, key: 'movie:heat:1995' })],
      ['/plays/top', () => plays.top({ days: 365, metric: 'plays', limit: 25 })],
      ['/plays/never-played', () => plays.neverPlayed({ ...paging, q: '' })],
      ['/plays/sync', () => plays.sync()],
    ]

    const opened = responses.map(([route, respond]) => {
      countConnections()
      respond()
      return [route, connectionsOpened()] as const
    })

    expect(Object.fromEntries(opened)).toEqual(
      Object.fromEntries(responses.map(([route]) => [route, 1])),
    )
  })

  it('advances every container on a host in one transaction', () => {
    // A round that dies partway leaves no container ahead of its siblings.
    const path = tempDbPath()
    session({ path, work: initIncidents })
    const checks = [0, 1, 2].map((index) =>
      checkResult({ target: `container:meleys/app${index}`, ok: false, reason: 'not_running' }),
    )

    expect(() =>
      session({
        path,
        work: (connection) => {
          checks.slice(0, 2).forEach((check) => record({ connection, result: check, at: T0 }))
          throw new Error('docker endpoint died mid-round')
        },
      }),
    ).toThrow('docker endpoint died mid-round')

    const streaks = session({
      path,
      work: (connection) =>
        countOf(connection.prepare('SELECT COUNT(*) AS n FROM check_streak').get()),
    })
    expect(streaks).toBe(0)
  })

  describe('with an initialized connection', () => {
    let db: Connection

    const start = (): Connection => {
      db = openTestConnection({ init: [initStore, initRollups] })
      return db
    }

    afterEach(() => {
      db.close()
    })

    it('scans only what is new on compact', () => {
      // The second run over unchanged data must not redo the first one's work.
      //
      // Without a lower bound this re-read and re-upserted the whole retention
      // window every fifteen minutes, so a no-op cost exactly as much as a real
      // compaction and grew with the database.
      const connection = start()
      const offsets = Array.from({ length: 20 }, (_, index) => index * 60)
      offsets.forEach((offset) =>
        writeSamples({
          connection,
          target: 'host:meleys',
          at: at(offset),
          samples: [{ metric: 'load.1m', value: 1.0, kind: 'gauge' }],
        }),
      )
      const later = at(3600)

      const first = compact({ connection, name: '5m', now: later })
      const repeat = compact({ connection, name: '5m', now: later })

      expect(first).toBeGreaterThan(0)
      // only the newest already-written bucket is revisited, to absorb a late
      // sample; everything behind it is left alone
      expect(repeat).toBe(1)
    })

    it('still lands a late sample in the last compacted bucket', () => {
      const connection = start()
      writeSamples({
        connection,
        target: 'host:meleys',
        at: T0,
        samples: [{ metric: 'load.1m', value: 1.0, kind: 'gauge' }],
      })
      const later = at(3600)
      compact({ connection, name: '5m', now: later })

      writeSamples({
        connection,
        target: 'host:meleys',
        at: at(30),
        samples: [{ metric: 'load.1m', value: 3.0, kind: 'gauge' }],
      })
      compact({ connection, name: '5m', now: later })

      const rows = read({ connection, name: '5m', target: 'host:meleys', metric: 'load.1m' })
      expect(rows.map((row) => [row[1], row[2], row[4]])).toEqual([[1.0, 3.0, 2]])
    })

    it('never lets an unknown resolution reach the query', () => {
      const connection = start()
      expect(() => compact({ connection, name: 'rollup_5m; DROP TABLE samples', now: T0 })).toThrow(
        RangeError,
      )
      expect(() =>
        read({ connection, name: '7d', target: 'host:meleys', metric: 'load.1m' }),
      ).toThrow(RangeError)
    })
  })

  it('carries its own retention on every resolution', () => {
    expect(new Set(RESOLUTIONS.map((tier) => tier.name))).toEqual(new Set(['5m', '1h']))
    expect(RESOLUTIONS.map((tier) => tier.table)).toEqual(['rollup_5m', 'rollup_1h'])
  })

  it('gives the transport factor exactly one home', () => {
    expect(config.MAX_ROUND_SECONDS).toBe(
      (config.VITALS_TIMEOUT + config.SLOW_TIMEOUT) * CAPTURE_FACTOR,
    )
    expect('SSH_CAPTURE_FACTOR' in config).toBe(false)
  })

  it('makes a tick wait for a compaction rather than lose itself', async () => {
    // Compaction runs beside the ticks, so it can genuinely overlap a round's
    // write. sqlite serializes writers, and on a short busy timeout the round
    // loses its whole tick to "database is locked" instead of waiting a moment
    // for the lock.
    const path = tempDbPath()
    session({
      path,
      work: (connection) => {
        initStore(connection)
        initIncidents(connection)
      },
    })

    const holder = spawn(process.execPath, ['-e', HOLD_THE_WRITE_LOCK, path, isoformat(T0)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const exited = once(holder, 'exit')
    const holding = new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve())
      holder.once('exit', (code) => reject(new Error(`the holder exited ${code} before holding`)))
    })
    await holding

    const started = performance.now()
    session({
      path,
      work: (connection) =>
        record({
          connection,
          result: checkResult({ target: 'host:meleys', ok: true, reason: '' }),
          at: T0,
        }),
    })
    const waited = performance.now() - started

    // the join: the holder committed and exited cleanly. A tick that failed
    // instead of waiting has already thrown above, and the holder exits on
    // its own half a second after it took the lock.
    const [code] = await exited
    expect(code).toBe(0)

    // not in the Python test: proof the holder really held the lock, so the
    // tick above waited for it rather than never meeting it
    expect(waited).toBeGreaterThan(250)
    expect(
      session({ path, work: (connection) => observedRun({ connection, target: 'host:meleys' }) }),
    ).not.toBeNull()
  })

  it("keeps a reader out of a writer's way with WAL", () => {
    const path = tempDbPath()
    session({ path, work: initStore })
    const mode = session({
      path,
      work: (connection) => asRow(connection.prepare('PRAGMA journal_mode').get()),
    })
    expect(fields(mode ?? {}).text('journal_mode')).toBe('wal')
  })

  // The rest are not in the Python suite. They pin what the better-sqlite3
  // session does differently: Python's sqlite3 began its implicit transaction
  // at the first write and waited out the busy timeout there, while this one
  // begins the transaction itself, and the `mode` it is given decides whether
  // the write lock is taken up front.

  it('gives a writer thirty seconds to wait out another', () => {
    const path = tempDbPath()
    expect(
      session({ path, work: (connection) => connection.pragma('busy_timeout', { simple: true }) }),
    ).toBe(30_000)
  })

  describe('with another writer on the file', () => {
    let other: Connection | null = null

    // A second connection standing in for the other process, with a short
    // busy timeout so a test that makes it wait fails fast instead of
    // blocking this thread for thirty seconds.
    const otherWriter = (path: string): Connection => {
      other = openConnection(path)
      other.pragma('busy_timeout = 50')
      return other
    }

    afterEach(() => {
      other?.close()
      other = null
    })

    it('takes the write lock up front by default, so another writer waits for the unit', () => {
      const path = tempDbPath()
      session({ path, work: initStore })
      const writer = otherWriter(path)

      session({
        path,
        work: (connection) => {
          lastHeartbeat(connection)
          expect(() => writeHeartbeat({ connection: writer, at: at(30) })).toThrow(/locked|busy/i)
          writeHeartbeat({ connection, at: T0 })
        },
      })

      expect(session({ path, mode: 'read', work: lastHeartbeat })).toEqual(T0)
    })

    it('leaves the write lock free in a read unit, so the collector never waits on a request', () => {
      const path = tempDbPath()
      session({ path, work: initStore })
      const writer = otherWriter(path)

      const seen = session({
        path,
        mode: 'read',
        work: (connection) => {
          const before = lastHeartbeat(connection)
          writeHeartbeat({ connection: writer, at: T0 })
          // one consistent snapshot: the read unit still sees what it began with
          return { before, after: lastHeartbeat(connection) }
        },
      })

      expect(seen).toEqual({ before: null, after: null })
      expect(session({ path, mode: 'read', work: lastHeartbeat })).toEqual(T0)
    })
  })
})
