import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ROUND_SECONDS, VITALS_INTERVAL } from '@/config.js'
import type { Connection } from '@/db.js'
import {
  COVERAGE_GAP_SECONDS,
  coverageSince,
  initDb,
  lastHeartbeat,
  latest,
  metricAges,
  metricSeries,
  rate,
  rateSeries,
  series,
  writeHeartbeat,
  writeSamples,
} from '@/store.js'
import { openTestConnection, removeTempDirs } from '@/test/support.js'
import { addSeconds } from '@/time.js'

const HOUR = 3600
const DAY = 24 * HOUR

const T0 = new Date(Date.UTC(2026, 7, 10, 12, 0, 0))

/** T0 moved by a number of seconds, the `T0 + timedelta(...)` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

// `latest` takes the same required floor `metricAges` does. Where a test is
// about storage rather than about the floor, it passes one wide enough that the
// floor never participates in what is under test.
const ANY_AGE = at(-30 * DAY)

describe('store', () => {
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [initDb] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  it('writes and reads latest', () => {
    writeSamples({
      connection: db,
      target: 'host:vermithor',
      at: T0,
      samples: [
        { metric: 'load.1m', value: 0.46, kind: 'gauge' },
        { metric: 'mem.total_bytes', value: 16_642_768_896.0, kind: 'gauge' },
      ],
    })

    expect(latest({ connection: db, target: 'host:vermithor', since: ANY_AGE })).toEqual({
      'load.1m': 0.46,
      'mem.total_bytes': 16_642_768_896.0,
    })
  })

  it('returns the newest value per metric from latest', () => {
    writeSamples({
      connection: db,
      target: 'host:meleys',
      at: T0,
      samples: [{ metric: 'load.1m', value: 1.01, kind: 'gauge' }],
    })
    writeSamples({
      connection: db,
      target: 'host:meleys',
      at: at(30),
      samples: [{ metric: 'load.1m', value: 0.75, kind: 'gauge' }],
    })

    expect(latest({ connection: db, target: 'host:meleys', since: ANY_AGE })['load.1m']).toBe(0.75)
  })

  it('reads latest as empty for an unknown target', () => {
    expect(latest({ connection: db, target: 'host:nope', since: ANY_AGE })).toEqual({})
  })

  it('orders and windows a series', () => {
    const offsets = [0, 30, 60]
    offsets.forEach((offset) =>
      writeSamples({
        connection: db,
        target: 'host:syrax',
        at: at(offset),
        samples: [{ metric: 'load.1m', value: offset / 100, kind: 'gauge' }],
      }),
    )

    const points = series({
      connection: db,
      target: 'host:syrax',
      metric: 'load.1m',
      since: at(15),
    })

    expect(points.map(([, value]) => value)).toEqual([0.3, 0.6])
    expect(points[0][0]).toEqual(at(30))
  })

  it('groups the requested metrics in time order in metric series', () => {
    const ticks = [
      [0, 100.0, 900.0],
      [30, 150.0, 950.0],
    ] as const
    ticks.forEach(([offset, user, idle]) =>
      writeSamples({
        connection: db,
        target: 'host:syrax',
        at: at(offset),
        samples: [
          { metric: 'cpu.total.user', value: user, kind: 'counter' },
          { metric: 'cpu.total.idle', value: idle, kind: 'counter' },
          { metric: 'load.1m', value: 0.5, kind: 'gauge' },
        ],
      }),
    )

    const result = metricSeries({
      connection: db,
      target: 'host:syrax',
      metrics: ['cpu.total.user', 'cpu.total.idle'],
      since: ANY_AGE,
    })

    expect(result).toEqual({
      'cpu.total.user': [
        [T0, 100.0],
        [at(30), 150.0],
      ],
      'cpu.total.idle': [
        [T0, 900.0],
        [at(30), 950.0],
      ],
    })
  })

  it('windows metric series and scopes them to the target', () => {
    writeSamples({
      connection: db,
      target: 'host:syrax',
      at: at(-2 * HOUR),
      samples: [{ metric: 'cpu.total.user', value: 1.0, kind: 'counter' }],
    })
    writeSamples({
      connection: db,
      target: 'host:meleys',
      at: T0,
      samples: [{ metric: 'cpu.total.user', value: 2.0, kind: 'counter' }],
    })
    writeSamples({
      connection: db,
      target: 'host:syrax',
      at: T0,
      samples: [{ metric: 'cpu.total.user', value: 3.0, kind: 'counter' }],
    })

    const result = metricSeries({
      connection: db,
      target: 'host:syrax',
      metrics: ['cpu.total.user'],
      since: at(-HOUR),
    })

    // a metric with no rows in the window is absent, not an empty series: the
    // caller cannot tell those apart and must not need to
    expect(result).toEqual({ 'cpu.total.user': [[T0, 3.0]] })
  })

  it('divides a rate by elapsed seconds', () => {
    expect(rate({ previous: [T0, 1000.0], current: [at(10), 2000.0] })).toBe(100.0)
  })

  it('returns null for a rate on a counter reset', () => {
    // a reboot zeroes /proc counters; rendering that as a negative or a huge
    // spike would be a lie, so the delta is dropped
    expect(rate({ previous: [T0, 5000.0], current: [at(10), 12.0] })).toBeNull()
  })

  it('returns null for a rate on zero or negative elapsed', () => {
    expect(rate({ previous: [T0, 1.0], current: [T0, 2.0] })).toBeNull()
    expect(rate({ previous: [T0, 1.0], current: [at(-5), 2.0] })).toBeNull()
  })

  it('drops the reset pair from a rate series and keeps the rest', () => {
    const points = [
      [T0, 100.0],
      [at(10), 200.0],
      [at(20), 5.0], // reboot
      [at(30), 105.0],
    ] as const
    const got = rateSeries(points)

    expect(got.map(([, value]) => value)).toEqual([10.0, 10.0])
    expect(got.map(([when]) => when)).toEqual([at(10), at(30)])
  })

  it('needs two points for a rate series', () => {
    expect(rateSeries([[T0, 1.0]])).toEqual([])
    expect(rateSeries([])).toEqual([])
  })

  it('roundtrips the heartbeat', () => {
    expect(lastHeartbeat(db)).toBeNull()
    writeHeartbeat({ connection: db, at: T0 })
    expect(lastHeartbeat(db)).toEqual(T0)
  })

  it('drops a metric source that stopped producing from metric ages', () => {
    // a veth renamed by a container restart is written once and never again.
    // Without the floor its one timestamp is still the oldest thing on the
    // host a week later, and every staleness signal derived from it is pinned.
    writeSamples({
      connection: db,
      target: 'host:vermithor',
      at: at(-3 * DAY),
      samples: [{ metric: 'net.veth8a3f21.rx_bytes', value: 12.0, kind: 'counter' }],
    })
    writeSamples({
      connection: db,
      target: 'host:vermithor',
      at: T0,
      samples: [{ metric: 'load.1m', value: 0.4, kind: 'gauge' }],
    })

    const ages = metricAges({ connection: db, target: 'host:vermithor', since: at(-24 * HOUR) })

    expect(Object.keys(ages)).toEqual(['load.1m'])
    expect(ages['load.1m']).toEqual(T0)
  })

  it('keeps a metric that is merely late in metric ages', () => {
    // the floor must sit far above the staleness threshold, or nothing could
    // ever be reported stale: a late metric has to survive to be caught
    writeSamples({
      connection: db,
      target: 'host:vermithor',
      at: at(-6 * HOUR),
      samples: [{ metric: 'disk.volume1.used_percent', value: 42.0, kind: 'gauge' }],
    })

    const ages = metricAges({ connection: db, target: 'host:vermithor', since: at(-24 * HOUR) })

    expect(ages['disk.volume1.used_percent']).toEqual(at(-6 * HOUR))
  })

  it('starts coverage at the first heartbeat', () => {
    expect(coverageSince(db)).toBeNull()
    writeHeartbeat({ connection: db, at: T0 })
    expect(coverageSince(db)).toEqual(T0)
  })

  it('keeps coverage across consecutive rounds', () => {
    const offsets = [0, 30, 60, 90]
    offsets.forEach((offset) => writeHeartbeat({ connection: db, at: at(offset) }))

    expect(coverageSince(db)).toEqual(T0)
  })

  it('restarts coverage on a gap in the rounds', () => {
    // the collector was down for those hours. Nobody watched them, and an
    // empty incident history over unwatched hours is not proof of uptime.
    writeHeartbeat({ connection: db, at: T0 })
    writeHeartbeat({ connection: db, at: at(8 * HOUR) })

    expect(coverageSince(db)).toEqual(at(8 * HOUR))
  })

  it('restarts coverage on a backwards clock step', () => {
    writeHeartbeat({ connection: db, at: T0 })
    writeHeartbeat({ connection: db, at: at(-2 * HOUR) })

    expect(coverageSince(db)).toEqual(at(-2 * HOUR))
  })

  it('drops a reading from latest that the age window cannot date', () => {
    // samples live seven days and the age window is a day, so an unfloored read
    // hands back values metricAges has already dropped: a number on the page
    // with no age accounted for anywhere, which is how a week-old disk reading
    // rendered under a bare "Healthy"
    writeSamples({
      connection: db,
      target: 'host:caraxes',
      at: at(-7 * DAY),
      samples: [{ metric: 'disk.volume1.used_percent', value: 42.0, kind: 'gauge' }],
    })
    writeSamples({
      connection: db,
      target: 'host:caraxes',
      at: T0,
      samples: [{ metric: 'load.1m', value: 0.1, kind: 'gauge' }],
    })

    const floor = at(-24 * HOUR)

    expect(Object.keys(latest({ connection: db, target: 'host:caraxes', since: floor }))).toEqual([
      'load.1m',
    ])
    // the two reads agree by construction: same floor, same set
    expect(
      new Set(Object.keys(latest({ connection: db, target: 'host:caraxes', since: floor }))),
    ).toEqual(
      new Set(Object.keys(metricAges({ connection: db, target: 'host:caraxes', since: floor }))),
    )
  })

  it('keeps a reading in latest that is merely late', () => {
    // the floor must not swallow the detection band: a metric between its
    // refresh interval and the window still has to be reported, with its age,
    // so the page can call it stale rather than silently drop it
    writeSamples({
      connection: db,
      target: 'host:caraxes',
      at: at(-6 * HOUR),
      samples: [{ metric: 'disk.volume1.used_percent', value: 42.0, kind: 'gauge' }],
    })

    const got = latest({ connection: db, target: 'host:caraxes', since: at(-24 * HOUR) })

    expect(got['disk.volume1.used_percent']).toBe(42.0)
  })

  it('never restarts coverage on a slow round', () => {
    // the gap is measured between round starts, so a round's own duration is
    // spent inside it. A slow round can spend MAX_ROUND_SECONDS on ssh before
    // the loop sleeps VITALS_INTERVAL again: ~120s apart, collector never
    // stopped. A 90s tolerance tripped on that every 15 minutes and blanked
    // every uptime score for the following 24 hours.
    writeHeartbeat({ connection: db, at: T0 })
    writeHeartbeat({ connection: db, at: at(120) })

    expect(coverageSince(db)).toEqual(T0)
  })

  it('admits a worst-case round in the coverage gap', () => {
    // stated as arithmetic so the constant cannot drift back under the round
    // duration it has to tolerate
    const worstCase = MAX_ROUND_SECONDS + VITALS_INTERVAL

    expect(COVERAGE_GAP_SECONDS).toBeGreaterThan(worstCase)
  })

  it('makes init db idempotent', () => {
    // the Python test leaned on the fixture's one init; initialising a second
    // time is what the name claims, so it does that here
    initDb(db)
    writeSamples({
      connection: db,
      target: 'host:vhagar',
      at: T0,
      samples: [{ metric: 'load.1m', value: 0.14, kind: 'gauge' }],
    })

    expect(latest({ connection: db, target: 'host:vhagar', since: ANY_AGE })['load.1m']).toBe(0.14)
  })
})
