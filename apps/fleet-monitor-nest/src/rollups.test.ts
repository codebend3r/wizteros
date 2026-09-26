import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connection } from '@/db.js'
import {
  bucket,
  compact,
  initDb as initRollups,
  prune,
  read,
  resolution,
  SAMPLE_RETENTION_SECONDS,
} from '@/rollups.js'
import { initDb as initStore, latest, writeSamples } from '@/store.js'
import { openTestConnection, removeTempDirs } from '@/test/support.js'
import { addSeconds } from '@/time.js'

const MINUTE = 60
const HOUR = 3600
const DAY = 24 * HOUR

const T0 = new Date(Date.UTC(2026, 7, 10, 12, 0, 0))

/** T0 moved by a number of seconds, the `T0 + timedelta(...)` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

// these tests are about retention, not about the age floor `latest` takes, so
// the floor is set wide enough that it never decides an assertion here
const ANY_AGE = at(-30 * DAY)

describe('rollups', () => {
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [initStore, initRollups] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  const gauge = ({ target, when, value }: { target: string; when: Date; value: number }) =>
    writeSamples({
      connection: db,
      target,
      at: when,
      samples: [{ metric: 'load.1m', value, kind: 'gauge' }],
    })

  it('floors a bucket to the resolution', () => {
    const when = new Date(Date.UTC(2026, 7, 10, 12, 7, 43))

    expect(bucket({ at: when, seconds: 300 })).toEqual(new Date(Date.UTC(2026, 7, 10, 12, 5)))
    expect(bucket({ at: when, seconds: 3600 })).toEqual(new Date(Date.UTC(2026, 7, 10, 12, 0)))
  })

  it('writes min, max and avg per bucket on compact', () => {
    const readings = [
      [0, 1.0],
      [60, 3.0],
      [120, 2.0],
    ] as const
    readings.forEach(([offset, value]) => gauge({ target: 'host:meleys', when: at(offset), value }))

    const written = compact({ connection: db, name: '5m', now: at(HOUR) })

    expect(written).toBe(1)
    const rows = read({ connection: db, name: '5m', target: 'host:meleys', metric: 'load.1m' })
    expect(rows).toEqual([[T0, 1.0, 3.0, 2.0, 3]])
  })

  it('does not touch the current bucket on compact', () => {
    // the bucket still filling would be compacted from partial data and then
    // never corrected, so it is left alone until it closes
    gauge({ target: 'host:meleys', when: T0, value: 1.0 })

    expect(compact({ connection: db, name: '5m', now: at(30) })).toBe(0)
  })

  it('makes compact idempotent', () => {
    gauge({ target: 'host:meleys', when: T0, value: 1.0 })

    compact({ connection: db, name: '5m', now: at(HOUR) })
    compact({ connection: db, name: '5m', now: at(HOUR) })

    expect(
      read({ connection: db, name: '5m', target: 'host:meleys', metric: 'load.1m' }),
    ).toHaveLength(1)
  })

  it('drops raw samples past retention on prune', () => {
    gauge({ target: 'host:syrax', when: at(-8 * DAY), value: 9.0 })
    gauge({ target: 'host:syrax', when: T0, value: 1.0 })

    const dropped = prune({ connection: db, now: T0 })

    expect(dropped['samples']).toBe(1)
    expect(latest({ connection: db, target: 'host:syrax', since: ANY_AGE })['load.1m']).toBe(1.0)
  })

  it('makes the prune boundary strictly older than the window', () => {
    gauge({ target: 'host:onboundary', when: at(-7 * DAY), value: 1.0 })
    gauge({ target: 'host:pastboundary', when: at(-(7 * DAY + 1)), value: 2.0 })

    prune({ connection: db, now: T0 })

    expect(latest({ connection: db, target: 'host:onboundary', since: ANY_AGE })['load.1m']).toBe(
      1.0,
    )
    expect(latest({ connection: db, target: 'host:pastboundary', since: ANY_AGE })).toEqual({})
  })

  it('keeps rollups longer than raw on prune', () => {
    expect(SAMPLE_RETENTION_SECONDS).toBe(7 * DAY)
    expect(resolution('5m').retention).toBe(90 * DAY)
    expect(resolution('1h').retention).toBe(730 * DAY)

    const old = at(-8 * DAY)
    gauge({ target: 'host:vhagar', when: old, value: 9.0 })
    compact({ connection: db, name: '5m', now: addSeconds({ at: old, seconds: 10 * MINUTE }) })
    compact({ connection: db, name: '1h', now: addSeconds({ at: old, seconds: 2 * HOUR }) })

    prune({ connection: db, now: T0 })

    expect(latest({ connection: db, target: 'host:vhagar', since: ANY_AGE })).toEqual({})
    expect(
      read({ connection: db, name: '5m', target: 'host:vhagar', metric: 'load.1m' }),
    ).toHaveLength(1)
    expect(
      read({ connection: db, name: '1h', target: 'host:vhagar', metric: 'load.1m' }),
    ).toHaveLength(1)
  })

  it('rejects an unknown resolution on read', () => {
    // the resolution names a table and so is interpolated rather than bound;
    // the membership check is the only thing between a caller's string and
    // the SQL, and `compact` has had it all along
    expect(() =>
      read({
        connection: db,
        name: '5m; DROP TABLE samples',
        target: 'host:vermithor',
        metric: 'load.1m',
      }),
    ).toThrow(RangeError)
  })

  it('returns the compacted buckets on read', () => {
    const readings = [
      [0, 1.0],
      [60, 3.0],
    ] as const
    readings.forEach(([offset, value]) =>
      gauge({ target: 'host:vermithor', when: at(offset), value }),
    )
    compact({ connection: db, name: '5m', now: at(10 * MINUTE) })

    const rows = read({ connection: db, name: '5m', target: 'host:vermithor', metric: 'load.1m' })

    expect(rows).toHaveLength(1)
    expect(rows[0][1]).toBe(1.0)
    expect(rows[0][2]).toBe(3.0)
  })
})
