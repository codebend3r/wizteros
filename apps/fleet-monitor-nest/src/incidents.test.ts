import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connection } from '@/db.js'
import {
  checkResult,
  history,
  initDb,
  type ObservedRun,
  observedRun,
  openIncidents,
  record,
  retireAbsent,
  uptimePercent,
} from '@/incidents.js'
import { openTestConnection, removeTempDirs } from '@/test/support.js'
import { addSeconds, parseIso } from '@/time.js'

const MINUTE = 60
const HOUR = 3600
const DAY = 24 * HOUR

const T0 = new Date(Date.UTC(2026, 7, 10, 12, 0, 0))

/** T0 moved by a number of seconds, the `T0 + timedelta(...)` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

/**
 * The observed run a test means when it says "the collector watched this".
 *
 * Both ends are stated rather than assumed: uptimePercent scores a window
 * only when the run covers it end to end, so a test that names just the start
 * would be asserting a score over hours whose observation it never claimed.
 */
const watched = ({ since, until }: { since: Date; until: Date }): ObservedRun => ({ since, until })

describe('incidents', () => {
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [initDb] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  const feed = ({
    target,
    flags,
    start = T0,
    step = 30,
  }: {
    target: string
    flags: readonly boolean[]
    start?: Date
    step?: number
  }) =>
    flags.map((ok, index) =>
      record({
        connection: db,
        result: checkResult({ target, ok, reason: ok ? '' : 'refused' }),
        at: addSeconds({ at: start, seconds: step * index }),
      }),
    )

  /** The run a test just fed, which it knows exists. */
  const runOf = (target: string): ObservedRun => {
    const run = observedRun({ connection: db, target })
    if (run === null) {
      throw new Error(`no observed run for ${target}`)
    }
    return run
  }

  it('does not open an incident on a single failure', () => {
    feed({ target: 'container:meleys/sonarr', flags: [true, false, true] })

    expect(openIncidents(db)).toEqual([])
  })

  it('opens an incident on two consecutive failures', () => {
    feed({ target: 'container:meleys/sonarr', flags: [true, false, false] })

    const openRows = openIncidents(db)
    expect(openRows).toHaveLength(1)
    expect(openRows[0].target).toBe('container:meleys/sonarr')
    expect(openRows[0].reason).toBe('refused')
    expect(openRows[0].closed_at).toBeNull()
  })

  it('closes it on two consecutive successes', () => {
    feed({ target: 'host:caraxes', flags: [false, false, true, true] })

    expect(openIncidents(db)).toEqual([])
    const closed = history({ connection: db, since: at(-HOUR) })
    expect(closed).toHaveLength(1)
    expect(closed[0].closed_at).not.toBeNull()
  })

  it('does not close an open incident on a flap inside it', () => {
    feed({ target: 'host:caraxes', flags: [false, false, true, false, false] })

    expect(openIncidents(db)).toHaveLength(1)
  })

  it('opens a second incident on a second outage', () => {
    feed({ target: 'host:syrax', flags: [false, false, true, true, false, false] })

    expect(openIncidents(db)).toHaveLength(1)
    expect(history({ connection: db, since: at(-HOUR) })).toHaveLength(2)
  })

  it('computes uptime percent over a window', () => {
    // down for the middle 30 minutes of a 60 minute window
    record({
      connection: db,
      result: checkResult({ target: 'host:vhagar', ok: false, reason: 'timeout' }),
      at: T0,
    })
    record({
      connection: db,
      result: checkResult({ target: 'host:vhagar', ok: false, reason: 'timeout' }),
      at: at(30),
    })
    record({
      connection: db,
      result: checkResult({ target: 'host:vhagar', ok: true, reason: '' }),
      at: at(30 * MINUTE),
    })
    record({
      connection: db,
      result: checkResult({ target: 'host:vhagar', ok: true, reason: '' }),
      at: at(30 * MINUTE + 30),
    })

    const got = uptimePercent({
      connection: db,
      target: 'host:vhagar',
      since: T0,
      now: at(HOUR),
      observed: watched({ since: T0, until: at(HOUR) }),
    })

    expect(got).toBeGreaterThan(49.0)
    expect(got).toBeLessThan(51.0)
  })

  it('makes uptime 100 with no incidents', () => {
    feed({ target: 'host:vermithor', flags: [true, true, true] })

    expect(
      uptimePercent({
        connection: db,
        target: 'host:vermithor',
        since: T0,
        now: at(HOUR),
        observed: watched({ since: T0, until: at(HOUR) }),
      }),
    ).toBe(100.0)
  })

  it('never shows an always healthy target in history', () => {
    feed({ target: 'host:vermithor', flags: [true, true, true, true] })

    expect(history({ connection: db, since: at(-HOUR) })).toEqual([])
  })

  it('closes an incident for a removed container on retire absent', () => {
    // a container removed while down would otherwise stay "open" forever and
    // drag its uptime toward zero for eternity
    feed({ target: 'container:meleys/oldapp', flags: [false, false] })
    expect(openIncidents(db)).toHaveLength(1)

    const closed = retireAbsent({
      connection: db,
      prefix: 'container:meleys/',
      seen: new Set(['sonarr', 'radarr']),
      at: at(5 * MINUTE),
    })

    expect(closed).toBe(1)
    expect(openIncidents(db)).toEqual([])
    expect(history({ connection: db, since: at(-HOUR) })[0].reason).toBe('removed')
  })

  it('leaves a still present container alone on retire absent', () => {
    feed({ target: 'container:meleys/sonarr', flags: [false, false] })

    const closed = retireAbsent({
      connection: db,
      prefix: 'container:meleys/',
      seen: new Set(['sonarr']),
      at: at(5 * MINUTE),
    })

    expect(closed).toBe(0)
    expect(openIncidents(db)).toHaveLength(1)
  })

  it('does not reach across hosts on retire absent', () => {
    // vermithor and meleys both run a container called sonarr; retiring one
    // host's set must never touch the other's
    feed({ target: 'container:vermithor/sonarr', flags: [false, false] })

    const closed = retireAbsent({
      connection: db,
      prefix: 'container:meleys/',
      seen: new Set(),
      at: at(5 * MINUTE),
    })

    expect(closed).toBe(0)
    expect(openIncidents(db)).toHaveLength(1)
  })

  it('needs no special casing for a newly discovered container', () => {
    // adding jellyfin to meleys must just work: first check, then normal rules
    feed({ target: 'container:meleys/jellyfin', flags: [true, true] })

    expect(openIncidents(db)).toEqual([])
    expect(
      uptimePercent({
        connection: db,
        target: 'container:meleys/jellyfin',
        since: T0,
        now: at(HOUR),
        observed: watched({ since: T0, until: at(HOUR) }),
      }),
    ).toBe(100.0)
  })

  it('stops uptime percent from degrading further on retire absent', () => {
    // this is the entire reason retireAbsent exists: without it, a container
    // removed while down stays "open" and drags uptime toward zero forever
    feed({ target: 'container:meleys/oldapp', flags: [false, false] }) // opens at T0 + 30s, never closes

    const stillOpen = uptimePercent({
      connection: db,
      target: 'container:meleys/oldapp',
      since: T0,
      now: at(HOUR),
      observed: watched({ since: T0, until: at(HOUR) }),
    })
    expect(stillOpen).toBeLessThan(5.0)

    retireAbsent({
      connection: db,
      prefix: 'container:meleys/',
      seen: new Set(),
      at: at(5 * MINUTE),
    })

    const anHourOut = uptimePercent({
      connection: db,
      target: 'container:meleys/oldapp',
      since: T0,
      now: at(HOUR),
      observed: watched({ since: T0, until: at(HOUR) }),
    })
    const aDayOut = uptimePercent({
      connection: db,
      target: 'container:meleys/oldapp',
      since: T0,
      now: at(DAY),
      observed: watched({ since: T0, until: at(DAY) }),
    })

    // retirement fixes the down time at (opened_at, retired_at); as `now`
    // keeps advancing past retirement, uptime climbs toward 100 instead of
    // trending toward 0 the way a permanently open incident would
    expect(anHourOut).toBeGreaterThan(90.0)
    expect(aDayOut).toBeGreaterThan(anHourOut ?? Number.POSITIVE_INFINITY)
  })

  it('clips an incident that opened before the window in uptime percent', () => {
    // opens at T0 + 30s, closes at T0 + 90s: a 60 second outage
    feed({ target: 'host:clip-check', flags: [false, false, true, true] })

    const since = at(60)
    const now = at(120)

    // since (T0+60s) falls inside the incident's [T0+30s, T0+90s) span, so
    // only the last 30 seconds of the outage are inside the window
    const got = uptimePercent({
      connection: db,
      target: 'host:clip-check',
      since,
      now,
      observed: watched({ since: T0, until: now }),
    })

    expect(got).toBeGreaterThan(49.0)
    expect(got).toBeLessThan(51.0)
  })

  it('makes uptime unknown for a window nobody watched', () => {
    // the collector was down for 23 of the 24 hours, so there are no incident
    // rows for them: not because the target was up, but because nothing was
    // looking. A flawless score for that day is the exact lie this guards.
    const now = at(24 * HOUR)
    feed({
      target: 'host:vermithor',
      flags: [true, true],
      start: addSeconds({ at: now, seconds: -MINUTE }),
    })

    expect(
      uptimePercent({
        connection: db,
        target: 'host:vermithor',
        since: T0,
        now,
        observed: watched({ since: addSeconds({ at: now, seconds: -HOUR }), until: now }),
      }),
    ).toBeNull()
  })

  it('scores a window the collector watched from the start', () => {
    feed({ target: 'host:vermithor', flags: [true, true] })

    expect(
      uptimePercent({
        connection: db,
        target: 'host:vermithor',
        since: T0,
        now: at(HOUR),
        observed: watched({ since: at(-HOUR), until: at(HOUR) }),
      }),
    ).toBe(100.0)
  })

  it('spans consecutive checks in the observed run', () => {
    feed({ target: 'host:vermithor', flags: [true, false, true, true] })

    const run = runOf('host:vermithor')

    expect(run.since).toEqual(T0)
    expect(run.until).toEqual(at(90))
  })

  it('has no observed run for a target that was never checked', () => {
    expect(observedRun({ connection: db, target: 'host:never-seen' })).toBeNull()
  })

  it("restarts a target's observed run on a gap in its checks", () => {
    // the collector kept ticking; this target was not observed by those ticks.
    // A run that spans the silence would score those hours as watched.
    record({ connection: db, result: checkResult({ target: 'host:caraxes', ok: true }), at: T0 })
    record({
      connection: db,
      result: checkResult({ target: 'host:caraxes', ok: true }),
      at: at(8 * HOUR),
    })

    expect(runOf('host:caraxes').since).toEqual(at(8 * HOUR))
  })

  it('restarts the observed run on a backwards clock step', () => {
    record({ connection: db, result: checkResult({ target: 'host:caraxes', ok: true }), at: T0 })
    record({
      connection: db,
      result: checkResult({ target: 'host:caraxes', ok: true }),
      at: at(-2 * HOUR),
    })

    expect(runOf('host:caraxes').since).toEqual(at(-2 * HOUR))
  })

  it('keeps the observed run advancing for a target that is down', () => {
    // per-target coverage must not go Unknown for the host that is actually
    // down: a down host still answers with a failed check, and a failed check
    // is an observation
    feed({ target: 'host:syrax', flags: Array.from({ length: 6 }, () => false) })

    const run = runOf('host:syrax')

    expect(run.since).toEqual(T0)
    expect(
      uptimePercent({
        connection: db,
        target: 'host:syrax',
        since: T0,
        now: at(5 * MINUTE),
        observed: watched({ since: T0, until: at(5 * MINUTE) }),
      }),
    ).toBeLessThan(100.0)
  })

  it('makes uptime unknown once a target stops being checked', () => {
    // a spawn_error records nothing for this target, so its run stops advancing
    // while the collector keeps ticking. Scoring the window from the run's
    // start alone hands back 100% for hours nothing observed.
    const now = at(24 * HOUR)
    feed({ target: 'host:vermithor', flags: [true, true] })

    expect(
      uptimePercent({
        connection: db,
        target: 'host:vermithor',
        since: T0,
        now,
        observed: runOf('host:vermithor'),
      }),
    ).toBeNull()
  })

  it('never restarts an observed run on a slow round', () => {
    // a vitals tick plus a slow tier plus the loop's own sleep can put two
    // rounds ~120s apart with the collector never having stopped
    record({ connection: db, result: checkResult({ target: 'host:meleys', ok: true }), at: T0 })
    record({
      connection: db,
      result: checkResult({ target: 'host:meleys', ok: true }),
      at: at(120),
    })

    expect(runOf('host:meleys').since).toEqual(T0)
  })

  it('updates the open incident reason on a continued failure', () => {
    // a target degrading from timeout to auth is the same outage, but the
    // operator needs the reason it is failing for now, not the one it opened
    // with
    const firstTwo = [0, 1]
    firstTwo.forEach((index) =>
      record({
        connection: db,
        result: checkResult({ target: 'host:syrax', ok: false, reason: 'timeout' }),
        at: at(30 * index),
      }),
    )
    expect(openIncidents(db)[0].reason).toBe('timeout')

    record({
      connection: db,
      result: checkResult({ target: 'host:syrax', ok: false, reason: 'auth' }),
      at: at(60),
    })

    expect(openIncidents(db)[0].reason).toBe('auth')
  })

  it('never overwrites a named reason with an unnamed failure', () => {
    const firstTwo = [0, 1]
    firstTwo.forEach((index) =>
      record({
        connection: db,
        result: checkResult({ target: 'host:syrax', ok: false, reason: 'timeout' }),
        at: at(30 * index),
      }),
    )

    record({
      connection: db,
      result: checkResult({ target: 'host:syrax', ok: false, reason: '' }),
      at: at(60),
    })

    expect(openIncidents(db)[0].reason).toBe('timeout')
  })

  it('honors a non-default threshold', () => {
    const target = 'host:threshold-check'
    const down = checkResult({ target, ok: false, reason: 'down' })

    record({ connection: db, result: down, at: T0, threshold: 3 })
    record({ connection: db, result: down, at: at(30), threshold: 3 })
    expect(openIncidents(db)).toEqual([])

    record({ connection: db, result: down, at: at(60), threshold: 3 })
    expect(openIncidents(db)).toHaveLength(1)
  })

  // Not in the Python suite. The live fleet.db was written by the Python
  // collector, and a copy old enough predates observed_since; this pins the
  // in-code migration the TS side now owns.
  it('carries a check_streak written before observed_since forward', () => {
    const old = openTestConnection()
    old
      .prepare(
        `CREATE TABLE check_streak (
    target         TEXT PRIMARY KEY,
    ok_run         INTEGER NOT NULL DEFAULT 0,
    fail_run       INTEGER NOT NULL DEFAULT 0,
    last_at        TEXT NOT NULL
)`,
      )
      .run()
    old
      .prepare('INSERT INTO check_streak (target, ok_run, fail_run, last_at) VALUES (?, ?, ?, ?)')
      .run('host:meleys', 3, 0, '2026-08-10T12:00:00.123456+00:00')

    initDb(old)
    initDb(old)

    // the backfill claims only the last check the old row proves
    expect(observedRun({ connection: old, target: 'host:meleys' })).toEqual({
      since: parseIso('2026-08-10T12:00:00.123456+00:00'),
      until: parseIso('2026-08-10T12:00:00.123456+00:00'),
    })
    old.close()
  })
})
