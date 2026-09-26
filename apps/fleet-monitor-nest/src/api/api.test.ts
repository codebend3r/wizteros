// The fleet routes over HTTP: /health, /fleet, the four histories and
// /incidents, driven through `inject` against the app main.ts serves.
//
// What the /fleet body means is pinned case by case in src/fleet.test.ts,
// directly on fleetView; the cases here are the same ones through the route,
// which is what the Python suite tested. The eight Python tests on the pure
// helpers (core_count, host_state, memory_used_percent) never touched a route
// and live in src/fleet.test.ts alone.

import { existsSync } from 'node:fs'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '@/collector.js'
import { session } from '@/db.js'
import { METRIC_AGE_WINDOW_SECONDS } from '@/fleet.js'
import { type CheckResult, checkResult, record } from '@/incidents.js'
import type { Sample } from '@/probes/types.js'
import { COVERAGE_GAP_SECONDS, metricAges, writeHeartbeat, writeSamples } from '@/store.js'
import { appPastTheGate } from '@/test/apiApp.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import {
  bodyOf,
  type FleetHost,
  type FleetResponse,
  isFleetResponse,
  isHealth,
  isIncidentFeed,
  isMetricHistory,
  type MetricHistory,
  type MetricPoint,
} from '@/test/wire.js'
import { addSeconds } from '@/time.js'

const HOUR = 3600
const DAY = 24 * HOUR
const GB = 1024 ** 3

const HISTORY_ROUTES = ['/fleet/cpu', '/fleet/memory', '/fleet/gpu', '/fleet/network']

const gauge = (metric: string, value: number): Sample => ({ metric, value, kind: 'gauge' })

const counter = (metric: string, value: number): Sample => ({ metric, value, kind: 'counter' })

// One session per write, the same way a collector round opens one. store and
// incidents take a connection, and the API under test opens its own, so a
// test seeding state has to commit through a session of its own.
const writeSamplesTo = ({
  path,
  target,
  at,
  samples,
}: {
  path: string
  target: string
  at: Date
  samples: readonly Sample[]
}): number =>
  session({ path, work: (connection) => writeSamples({ connection, target, at, samples }) })

const writeHeartbeatTo = ({ path, at, gap }: { path: string; at: Date; gap?: number }): void =>
  session({ path, work: (connection) => writeHeartbeat({ connection, at, gap }) })

const recordTo = ({
  path,
  result,
  at,
  gap,
}: {
  path: string
  result: CheckResult
  at: Date
  gap?: number
}): 'opened' | 'closed' | null =>
  session({ path, work: (connection) => record({ connection, result, at, gap }) })

const metricAgesIn = ({
  path,
  target,
  since,
}: {
  path: string
  target: string
  since: Date
}): Record<string, Date> =>
  session({ path, mode: 'read', work: (connection) => metricAges({ connection, target, since }) })

/**
 * Record the two healthy checks that say this target was observed from
 * `since` to `until`.
 *
 * Samples alone do not say that. A host with fresh readings whose checks
 * stopped hours ago has hours nobody looked at, and uptime over them is
 * unknown rather than perfect, so a test that wants a score has to state the
 * observation, not just the data.
 */
const watched = ({
  db,
  target,
  since,
  until,
  gap = COVERAGE_GAP_SECONDS,
}: {
  db: string
  target: string
  since: Date
  until: Date
  gap?: number
}): void =>
  [since, until].forEach((at) =>
    recordTo({ path: db, result: checkResult({ target, ok: true, reason: '' }), at, gap }),
  )

const cpuTick = (user: number, idle: number): readonly Sample[] => [
  counter('cpu.total.user', user),
  counter('cpu.total.idle', idle),
]

/** One host out of a /fleet body, which every configured host is always in. */
const hostNamed = (body: FleetResponse, name: string): FleetHost => {
  const found = body.hosts.find((host) => host.name === name)
  if (found === undefined) {
    throw new Error(`no host named ${name} in the /fleet body`)
  }
  return found
}

/** A history body's points, keyed by host name. */
const pointsByName = (payload: MetricHistory): Readonly<Record<string, readonly MetricPoint[]>> =>
  Object.fromEntries(payload.hosts.map((host) => [host.name, host.points]))

const values = (points: readonly MetricPoint[]): readonly number[] =>
  points.map((point) => point.value)

describe('the fleet API', () => {
  let app: NestFastifyApplication
  let db: string

  /**
   * An app already past the admin gate.
   *
   * What every test below asserts on is the fleet data, not who is allowed
   * to read it, so the session is stood down here rather than minted in each
   * of them. The gate itself (that it is on these routes at all, and what it
   * turns away) is tested for real in auth.test.ts.
   */
  beforeEach(async () => {
    db = tempDbPath()
    initDb(db)
    vi.stubEnv('FM_DB_PATH', db)
    app = await appPastTheGate()
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  const fleet = async (): Promise<FleetResponse> =>
    bodyOf({ answer: await get('/fleet'), is: isFleetResponse })

  const history = async (url: string): Promise<MetricHistory> =>
    bodyOf({ answer: await get(url), is: isMetricHistory })

  it('answers cross-origin requests', async () => {
    // The portal is served from a different origin than this API everywhere
    // it runs: the Vite dev server in development, the deployed portal
    // against vermithor:8010 in production. Without CORS headers the browser
    // discards the response and the /fleet page reports "Failed to fetch"
    // against a perfectly healthy API.
    const response = await get('/fleet', { origin: 'http://localhost:5173' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('*')

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/fleet',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    })
    expect(preflight.statusCode).toBe(200)
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('GET')
  })

  it('reports stale health when there is no heartbeat', async () => {
    const body = bodyOf({ answer: await get('/health'), is: isHealth })

    expect(body.stale).toBe(true)
    expect(body.heartbeat_age_seconds).toBeNull()
  })

  it('reports fresh health right after a heartbeat', async () => {
    writeHeartbeatTo({ path: db, at: new Date() })
    const body = bodyOf({ answer: await get('/health'), is: isHealth })

    expect(body.stale).toBe(false)
    expect(body.heartbeat_age_seconds).toBeLessThan(5)
  })

  it('reports stale health after three missed ticks', async () => {
    writeHeartbeatTo({ path: db, at: addSeconds({ at: new Date(), seconds: -200 }) })

    expect(bodyOf({ answer: await get('/health'), is: isHealth }).stale).toBe(true)
  })

  it('lists every configured host', async () => {
    writeSamplesTo({
      path: db,
      target: 'host:vermithor',
      at: new Date(),
      samples: [
        gauge('load.1m', 0.46),
        gauge('mem.total_bytes', 16_642_768_896.0),
        gauge('mem.available_bytes', 11_000_000_000.0),
      ],
    })
    const body = await fleet()

    expect(new Set(body.hosts.map((host) => host.name))).toEqual(
      new Set(['vermithor', 'meleys', 'syrax', 'vhagar', 'caraxes']),
    )
    const vermithor = hostNamed(body, 'vermithor')
    expect(vermithor.metrics['load.1m']).toBe(0.46)
    expect(vermithor.has_gpu).toBe(true)
  })

  it('marks a never-collected host as such', async () => {
    const caraxes = hostNamed(await fleet(), 'caraxes')

    // "not collected" must be its own state, never an implied healthy zero
    expect(caraxes.collected).toBe(false)
    expect(caraxes.metrics).toEqual({})
  })

  it('flags a host whose slow-tier metrics are stale', async () => {
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: addSeconds({ at: now, seconds: -6 * HOUR }),
      samples: [gauge('disk.percent', 42.0)],
    })
    const body = await fleet()
    const caraxes = hostNamed(body, 'caraxes')

    // the collector is alive and the fast tier is current, so the fleet-wide
    // heartbeat flag reads fresh; only the per-host metric age catches the
    // slow tier that died six hours ago behind it
    expect(body.stale).toBe(false)
    expect(caraxes.collected).toBe(true)
    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeGreaterThan(5 * HOUR)
  })

  it('never reports a reading it cannot date', async () => {
    // the slow tier (disk, temperatures) died a week ago while the fast tier
    // kept reporting. Samples live seven days and the age window is a day, so
    // the disk reading outlived the only thing that could date it: it dropped
    // out of metric_ages, `metrics_stale` went false on the strength of the
    // fresh load reading, and the card printed a bare "Healthy" over a
    // seven-day-old disk number with no stale note anywhere.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: addSeconds({ at: now, seconds: -7 * DAY }),
      samples: [gauge('disk.volume1.used_percent', 42.0)],
    })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    // the undatable value is absent, not reported as current
    expect(caraxes.metrics).not.toHaveProperty(['disk.volume1.used_percent'])
    expect(caraxes.metrics['load.1m']).toBe(0.1)
    // and what remains really is fresh, so saying so is not a lie
    expect(caraxes.metrics_stale).toBe(false)
    expect(caraxes.stalest_family_age_seconds).toBeLessThan(60)
  })

  it('dates every reading it reports', async () => {
    // the invariant behind the case above, stated directly: `metrics` and the
    // age computation must always describe the same set. A metric visible to
    // one and invisible to the other is a value on the page with no age
    // accounted for anywhere.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    const offsets: readonly (readonly [number, string])[] = [
      [0, 'load.1m'],
      [6 * HOUR, 'disk.volume1.used_percent'],
      [3 * DAY, 'temp.coretemp.package_c'],
      [7 * DAY, 'net.veth8a3f21.rx_bytes'],
    ]
    offsets.forEach(([offset, metric]) =>
      writeSamplesTo({
        path: db,
        target: 'host:caraxes',
        at: addSeconds({ at: now, seconds: -offset }),
        samples: [gauge(metric, 1.0)],
      }),
    )
    const caraxes = hostNamed(await fleet(), 'caraxes')

    const window = addSeconds({ at: now, seconds: -METRIC_AGE_WINDOW_SECONDS })
    expect(new Set(Object.keys(caraxes.metrics))).toEqual(
      new Set(Object.keys(metricAgesIn({ path: db, target: 'host:caraxes', since: window }))),
    )
    expect(new Set(Object.keys(caraxes.metrics))).toEqual(
      new Set(['load.1m', 'disk.volume1.used_percent']),
    )
  })

  it('stops reporting a container removed days ago as up', async () => {
    // same mechanism, different surface: container.<name>.up is a sample like
    // any other, so a container removed more than a day ago kept its last "1"
    // and the card kept rendering it "Up" indefinitely
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({ path: db, target: 'host:meleys', at: now, samples: [gauge('load.1m', 0.2)] })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -3 * DAY }),
      samples: [gauge('container.oldapp.up', 1.0)],
    })
    const meleys = hostNamed(await fleet(), 'meleys')

    expect(meleys.metrics).not.toHaveProperty(['container.oldapp.up'])
  })

  it('marks a host whose every reading aged out as not collected', async () => {
    // rows exist for this host, all of them older than the age window. That
    // is neither fresh nor never-collected, and the card's "no current
    // readings" copy is written for exactly this: not collected *now*.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:syrax',
      at: addSeconds({ at: now, seconds: -3 * DAY }),
      samples: [gauge('load.1m', 0.1)],
    })
    const syrax = hostNamed(await fleet(), 'syrax')

    expect(syrax.collected).toBe(false)
    expect(syrax.metrics).toEqual({})
    expect(syrax.metrics_stale).toBe(true)
    expect(syrax.stalest_family_age_seconds).toBeNull()
    expect(syrax.uptime_percent_24h).toBeNull()
  })

  it('gives a never-collected host no uptime', async () => {
    const caraxes = hostNamed(await fleet(), 'caraxes')

    // a host that was never checked is unknown, not a perfect uptime score
    expect(caraxes.uptime_percent_24h).toBeNull()
  })

  it('drops a metric source that stopped producing', async () => {
    // a veth renamed by a container restart is written once and never again.
    // Counted forever it pins metrics_stale true on a healthy docker host and
    // walks stalest_family_age_seconds up to seven days.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:vermithor',
      at: addSeconds({ at: now, seconds: -3 * DAY }),
      samples: [counter('net.veth8a3f21.rx_bytes', 12.0)],
    })
    writeSamplesTo({
      path: db,
      target: 'host:vermithor',
      at: now,
      samples: [gauge('load.1m', 0.4)],
    })
    const vermithor = hostNamed(await fleet(), 'vermithor')

    expect(vermithor.metrics_stale).toBe(false)
    expect(vermithor.stalest_family_age_seconds).toBeLessThan(60)
  })

  it('ignores a vanished source beside a live sibling', async () => {
    // meleys, 2026-08-26: DSM brought up a VPN tun1000 for one hour, and its
    // two counters froze when it went away. The age window is a day and the
    // stale band is 45 minutes, so under a plain `min` over every metric those
    // two dead readings reported the host stale for the next 23 hours while
    // net.eth0.* beside them updated every 30 seconds.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -17 * HOUR }),
      samples: [counter('net.tun1000.rx_bytes', 900.0)],
    })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [counter('net.eth0.rx_bytes', 12.0), gauge('load.1m', 0.4)],
    })
    const meleys = hostNamed(await fleet(), 'meleys')

    // the family is reporting, so the host is not stale on the strength of
    // one source that went away inside it
    expect(meleys.metrics_stale).toBe(false)
    expect(meleys.stalest_family_age_seconds).toBeLessThan(60)
    // and the dead counter is still a reading the monitor will hand back: it
    // is excluded from the staleness judgment, not hidden
    expect(meleys.metrics['net.tun1000.rx_bytes']).toBe(900.0)
  })

  it('still flags a family that went silent whole', async () => {
    // the other half of the same rule. Ignoring a vanished source must not
    // ignore a probe that stopped: when every metric under `disk` is old, no
    // sibling is left to vouch for it and the host is stale.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: addSeconds({ at: now, seconds: -6 * HOUR }),
      samples: [gauge('disk.volume1.used_percent', 42.0), gauge('disk.volume1.total_bytes', 8.0)],
    })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeGreaterThan(5 * HOUR)
  })

  it('names the family that fell silent', async () => {
    // the page prints this word. Without it the card blamed disk and
    // temperature whatever had actually stopped.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: addSeconds({ at: now, seconds: -6 * HOUR }),
      samples: [gauge('temp.coretemp.temp1', 44.0)],
    })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    expect(caraxes.stalest_family).toBe('temp')
  })

  it('reports no uptime for a window the collector did not watch', async () => {
    // the collector has been up for one round. Nothing observed the other 24
    // hours, and an empty incident history over unwatched hours is not proof
    // of uptime, so the honest answer is null, which the card reads as
    // "Unknown" rather than a perfect score.
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    expect(caraxes.collected).toBe(true)
    expect(caraxes.uptime_percent_24h).toBeNull()
  })

  it('scores uptime once the collector has watched the window', async () => {
    const now = new Date()
    const dayAndAnHourAgo = addSeconds({ at: now, seconds: -25 * HOUR })
    // one unbroken run reaching back past the window: two rounds is enough to
    // express that, with a gap tolerance wide enough to admit the second
    writeHeartbeatTo({ path: db, at: dayAndAnHourAgo })
    writeHeartbeatTo({ path: db, at: now, gap: 2 * DAY })
    // and the host itself checked across that run, not merely the collector
    // ticking beside it. A round that recorded no check for this host
    // observed the fleet, not the host.
    watched({ db, target: 'host:caraxes', since: dayAndAnHourAgo, until: now, gap: 2 * DAY })
    writeSamplesTo({ path: db, target: 'host:caraxes', at: now, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    expect(caraxes.uptime_percent_24h).toBe(100.0)
  })

  it('reports no uptime for a host the collector stopped checking', async () => {
    // a persistent spawn_error: ssh cannot be started, so no host check is
    // recorded, while the collector keeps ticking and the docker endpoints
    // beside it keep recording failures. The collector-wide coverage mark ran
    // on unbroken through hours in which not one host was observed, and
    // scored them a flawless 100%.
    const now = new Date()
    const sixHoursAgo = addSeconds({ at: now, seconds: -6 * HOUR })
    writeHeartbeatTo({ path: db, at: addSeconds({ at: now, seconds: -25 * HOUR }) })
    writeHeartbeatTo({ path: db, at: now, gap: 2 * DAY })
    // checks for this host stop six hours ago; its readings are still inside
    // the age window, so the card is still showing numbers
    watched({
      db,
      target: 'host:caraxes',
      since: addSeconds({ at: now, seconds: -25 * HOUR }),
      until: sixHoursAgo,
      gap: 2 * DAY,
    })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: sixHoursAgo,
      samples: [gauge('load.1m', 0.1)],
    })
    const caraxes = hostNamed(await fleet(), 'caraxes')

    expect(caraxes.collected).toBe(true)
    expect(caraxes.uptime_percent_24h).toBeNull()
  })

  it('never reads a future timestamp as fresh', async () => {
    // a clock that stepped backwards leaves rows stamped ahead of now. A
    // negative age clears every staleness threshold, so the page would show
    // frozen values and affirmatively call them current.
    const ahead = addSeconds({ at: new Date(), seconds: 6 * HOUR })
    writeHeartbeatTo({ path: db, at: ahead })
    writeSamplesTo({
      path: db,
      target: 'host:caraxes',
      at: ahead,
      samples: [gauge('load.1m', 0.1)],
    })

    const health = bodyOf({ answer: await get('/health'), is: isHealth })
    expect(health.stale).toBe(true)
    expect(health.heartbeat_age_seconds).toBeNull()

    const caraxes = hostNamed(await fleet(), 'caraxes')
    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeNull()
  })

  it('rejects absurdly large incident hours', async () => {
    const response = await get('/incidents?hours=999999999999999999')

    expect(response.statusCode).toBe(422)
  })

  it('rejects a negative incident window', async () => {
    // bounded above but not below: an extreme negative still overflowed the
    // timedelta into an unhandled 500 instead of a client error
    expect((await get('/incidents?hours=-999999999999999999')).statusCode).toBe(422)
    expect((await get('/incidents?hours=0')).statusCode).toBe(422)
  })

  it('splits open incidents from recent ones', async () => {
    const now = new Date()
    const offsets = [0, 30]
    offsets.forEach((offset) =>
      recordTo({
        path: db,
        result: checkResult({ target: 'host:caraxes', ok: false, reason: 'timeout' }),
        at: addSeconds({ at: now, seconds: offset }),
      }),
    )
    const body = bodyOf({ answer: await get('/incidents?hours=24'), is: isIncidentFeed })

    expect(body.open.map((incident) => incident.target)).toEqual(['host:caraxes'])
    expect(body.recent).toHaveLength(1)
  })

  it('divides load by the cores it observed', async () => {
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [
        ...[0, 1, 2, 3].map((index) => counter(`cpu${index}.user`, 1.0)),
        gauge('load.1m', 2.0),
      ],
    })

    const host = hostNamed(await fleet(), 'meleys')

    expect(host.cores).toBe(4)
    expect(host.load_per_core).toBe(0.5)
    expect(host.status).toBe('ok')
  })

  it('reports no load per core before the cpu rows arrive', async () => {
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({ path: db, target: 'host:meleys', at: now, samples: [gauge('load.1m', 2.0)] })

    const host = hostNamed(await fleet(), 'meleys')

    // dividing by a guessed core count would invent a number
    expect(host.cores).toBeNull()
    expect(host.load_per_core).toBeNull()
  })

  it('warns on a nearly full volume', async () => {
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [gauge('disk.volume1.used_percent', 94.0)],
    })

    const host = hostNamed(await fleet(), 'meleys')

    expect(host.status).toBe('warn')
  })

  it('reports the volume free space and its mount', async () => {
    // the card prints "{free} free" beside "/volume1 · of {total}", and both
    // facts belong to the monitor: the SPA must not hardcode which volume the
    // collector watches, nor derive free space from a rounded percentage
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [
        gauge('disk.volume1.used_percent', 62.0),
        gauge('disk.volume1.total_bytes', 8_000.0),
        gauge('disk.volume1.available_bytes', 3_000.0),
      ],
    })

    const host = hostNamed(await fleet(), 'meleys')

    expect(host.disk_available_bytes).toBe(3_000.0)
    expect(host.disk_mount).toBe('/volume1')
  })

  it('reports absent free space as absent', async () => {
    // a host that has not reported the reading, or was never collected at
    // all, carries null rather than a number invented from the percentage
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [gauge('disk.volume1.used_percent', 62.0)],
    })

    const body = await fleet()

    expect(hostNamed(body, 'meleys').disk_available_bytes).toBeNull()
    expect(hostNamed(body, 'caraxes').disk_available_bytes).toBeNull()
  })

  it('serves containers as objects', async () => {
    const now = new Date()
    writeHeartbeatTo({ path: db, at: now })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: now,
      samples: [
        gauge('container.plex.up', 1.0),
        gauge('container.plex.healthy', 1.0),
        gauge('container.plex.has_healthcheck', 1.0),
        gauge('container.radarr.up', 0.0),
        gauge('container.radarr.healthy', 0.0),
        gauge('container.radarr.has_healthcheck', 0.0),
      ],
    })

    const host = hostNamed(await fleet(), 'meleys')

    expect(host.containers).toEqual([
      { name: 'plex', up: true, healthy: true, has_healthcheck: true },
      { name: 'radarr', up: false, healthy: false, has_healthcheck: false },
    ])
  })

  it('reports cpu busy percent per host', async () => {
    const now = new Date()
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -60 }),
      samples: cpuTick(0.0, 0.0),
    })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -30 }),
      samples: cpuTick(25.0, 75.0),
    })

    const payload = await history('/fleet/cpu')

    expect(payload.window_minutes).toBe(60)
    const byName = pointsByName(payload)
    expect(payload.kind).toBe('cpu')
    expect(payload.unit).toBe('percent')
    expect(values(byName.meleys)).toEqual([25.0])
    // a host with no counters in the window has no points, not zeros
    expect(byName.vermithor).toEqual([])
  })

  it('lists cpu hosts in the same order as /fleet', async () => {
    // the portal binds one color per host by array position, on the cards
    // from /fleet and on the chart from here; the two must never disagree
    const fleetNames = (await fleet()).hosts.map((host) => host.name)
    const cpuNames = (await history('/fleet/cpu')).hosts.map((host) => host.name)

    expect(cpuNames).toEqual(fleetNames)
  })

  it('honors the requested cpu window', async () => {
    const now = new Date()
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -10 * 60 }),
      samples: cpuTick(0.0, 0.0),
    })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -9 * 60 }),
      samples: cpuTick(25.0, 75.0),
    })

    const narrow = await history('/fleet/cpu?minutes=5')
    const wide = await history('/fleet/cpu?minutes=30')

    expect(narrow.window_minutes).toBe(5)
    expect(narrow.hosts.map((host) => host.points)).toEqual([[], [], [], [], []])
    expect(values(wide.hosts[0].points)).toEqual([25.0])
  })

  it('rejects an out-of-range cpu window', async () => {
    expect((await get('/fleet/cpu?minutes=0')).statusCode).toBe(422)
    expect((await get('/fleet/cpu?minutes=100000')).statusCode).toBe(422)
  })

  it('accepts a week of cpu and refuses more', async () => {
    // raw samples live seven days, so a week is the widest window that can be
    // answered with readings rather than with silence
    expect((await get('/fleet/cpu?minutes=10080')).statusCode).toBe(200)
    expect((await get('/fleet/cpu?minutes=10081')).statusCode).toBe(422)
  })

  it('reports memory used percent per host', async () => {
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: new Date(), seconds: -30 }),
      samples: [gauge('mem.total_bytes', 16.0 * GB), gauge('mem.available_bytes', 4.0 * GB)],
    })

    const payload = await history('/fleet/memory')

    expect(payload.kind).toBe('memory')
    expect(payload.unit).toBe('percent')
    const byName = pointsByName(payload)
    expect(values(byName.meleys)).toEqual([75.0])
    // a host that reported no memory gauges has no points, not zeros
    expect(byName.vermithor).toEqual([])
  })

  it('reports the gpu frequency ratio as a percentage', async () => {
    writeSamplesTo({
      path: db,
      target: 'host:vermithor',
      at: addSeconds({ at: new Date(), seconds: -30 }),
      samples: [gauge('gpu.freq_ratio', 0.4)],
    })

    const payload = await history('/fleet/gpu')

    expect(payload.kind).toBe('gpu')
    expect(payload.unit).toBe('percent')
    const byName = pointsByName(payload)
    expect(values(byName.vermithor)).toEqual([40.0])
    // meleys has no render node at all, permanently: empty, never zero
    expect(byName.meleys).toEqual([])
  })

  it('sums every interface on the network route', async () => {
    const now = new Date()
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -40 }),
      samples: [counter('net.eth0.rx_bytes', 0.0), counter('net.eth1.tx_bytes', 0.0)],
    })
    writeSamplesTo({
      path: db,
      target: 'host:meleys',
      at: addSeconds({ at: now, seconds: -30 }),
      samples: [counter('net.eth0.rx_bytes', 1000.0), counter('net.eth1.tx_bytes', 500.0)],
    })

    const payload = await history('/fleet/network')

    expect(payload.kind).toBe('network')
    expect(payload.unit).toBe('bytes_per_second')
    expect(values(pointsByName(payload).meleys)).toEqual([150.0])
  })

  it('reads only this target and only net metrics on the network route', async () => {
    // the prefix read is a range scan over the metric column, so a
    // neighbouring family (or another host's counters) must not fall inside it
    const now = new Date()
    const ticks: readonly (readonly [number, number])[] = [
      [40, 0.0],
      [30, 1000.0],
    ]
    ticks.forEach(([offset, value]) => {
      const at = addSeconds({ at: now, seconds: -offset })
      writeSamplesTo({
        path: db,
        target: 'host:meleys',
        at,
        samples: [
          counter('net.eth0.rx_bytes', value),
          gauge('mem.total_bytes', 8.0 * GB),
          gauge('procs.total', 300.0),
        ],
      })
      writeSamplesTo({
        path: db,
        target: 'host:vermithor',
        at,
        samples: [counter('net.eth0.rx_bytes', value * 9)],
      })
    })

    const byName = pointsByName(await history('/fleet/network'))

    expect(values(byName.meleys)).toEqual([100.0])
    expect(values(byName.vermithor)).toEqual([900.0])
  })

  it('lists hosts in the same order as /fleet on every history route', async () => {
    // one colour per host position, bound on the cards from /fleet and on
    // every chart from these; a route disagreeing would recolour a whole chart
    const fleetNames = (await fleet()).hosts.map((host) => host.name)

    const routes = await Promise.all(
      HISTORY_ROUTES.map(async (path) => ({
        path,
        names: (await history(path)).hosts.map((host) => host.name),
      })),
    )
    routes.forEach(({ path, names }) => expect(names, path).toEqual(fleetNames))
  })

  it('shares one window contract on every history route', async () => {
    // the page drives all four from one range picker, so a route with its own
    // floor or ceiling would fail only at the extremes of that control
    const routes = await Promise.all(
      HISTORY_ROUTES.map(async (path) => ({
        path,
        floor: (await get(`${path}?minutes=1`)).statusCode,
        week: (await get(`${path}?minutes=10080`)).statusCode,
        past: (await get(`${path}?minutes=10081`)).statusCode,
        fallback: (await history(path)).window_minutes,
      })),
    )
    routes.forEach(({ path, floor, week, past, fallback }) => {
      expect(floor, path).toBe(422)
      expect(week, path).toBe(200)
      expect(past, path).toBe(422)
      expect(fallback, path).toBe(60)
    })
  })
})

describe('the fleet API on a fresh volume', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  it('creates its own schema on startup', async () => {
    // every other test in this file creates the schema itself, which masks
    // whether anything in the API ever did. Opening a SQLite file happily
    // creates an empty one, so against a fresh FM_DB_PATH the first query
    // raised "no such table: heartbeat" and answered 500. Starting the app is
    // exactly what is under test.
    const db = tempDbPath()
    expect(existsSync(db)).toBe(false)
    vi.stubEnv('FM_DB_PATH', db)
    // The gate is stood down too: what is under test is the schema.
    const app = await appPastTheGate()
    const get = (url: string) => app.inject({ method: 'GET', url })

    try {
      expect((await get('/health')).statusCode).toBe(200)
      expect((await get('/fleet')).statusCode).toBe(200)
      expect((await get('/incidents')).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
