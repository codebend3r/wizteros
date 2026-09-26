// The fleet view, exercised directly on a seeded database.
//
// Python had no test_fleet.py: fleet_view was tested through GET /fleet in
// test_api.py, and the helpers beside it (core_count, host_state,
// memory_used_percent) were tested there too. These are those cases, ported to
// call the module rather than the route; the route itself belongs to the API's
// own tests. The three /health cases become the same checks on the fleet's
// top-level `stale`, which is judged by the same ageSeconds and
// STALE_AFTER_SECONDS the health route uses.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connection } from '@/db.js'
import {
  METRIC_AGE_WINDOW_SECONDS,
  STALE_AFTER_SECONDS,
  ageSeconds,
  coreCount,
  fleetView,
  type HostView,
  hostState,
  memoryUsedPercent,
} from '@/fleet.js'
import { checkResult, initDb as initIncidents, record } from '@/incidents.js'
import type { Sample } from '@/probes/types.js'
import {
  COVERAGE_GAP_SECONDS,
  initDb as initStore,
  metricAges,
  writeHeartbeat,
  writeSamples,
} from '@/store.js'
import { openTestConnection, removeTempDirs } from '@/test/support.js'
import { addSeconds } from '@/time.js'

const HOUR = 3600
const DAY = 24 * HOUR

const NOW = new Date(Date.UTC(2026, 8, 26, 7, 0, 0))

/** NOW moved back by a number of seconds, the `now - timedelta(...)` of the Python tests. */
const ago = (seconds: number): Date => addSeconds({ at: NOW, seconds: -seconds })

const gauge = (metric: string, value: number): Sample => ({ metric, value, kind: 'gauge' })

const counter = (metric: string, value: number): Sample => ({ metric, value, kind: 'counter' })

describe('fleetView', () => {
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [initStore, initIncidents] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  const write = ({
    target,
    when,
    samples,
  }: {
    target: string
    when: Date
    samples: readonly Sample[]
  }) => writeSamples({ connection: db, target, at: when, samples })

  const heartbeat = ({ when, gap }: { when: Date; gap?: number }) =>
    writeHeartbeat({ connection: db, at: when, gap })

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
    target,
    since,
    until,
    gap = COVERAGE_GAP_SECONDS,
  }: {
    target: string
    since: Date
    until: Date
    gap?: number
  }) =>
    [since, until].forEach((when) =>
      record({ connection: db, result: checkResult({ target, ok: true }), at: when, gap }),
    )

  const view = () => fleetView({ connection: db, now: NOW })

  /** One host out of the view, which every configured host is always in. */
  const hostNamed = (name: string): HostView => {
    const found = view().hosts.find((host) => host.name === name)
    if (found === undefined) {
      throw new Error(`no host named ${name} in the fleet view`)
    }
    return found
  }

  // --- heartbeat --------------------------------------------------------

  it('reports stale when there is no heartbeat', () => {
    const fleet = view()

    expect(fleet.stale).toBe(true)
    expect(fleet.collected_at).toBeNull()
    expect(ageSeconds({ now: NOW, at: fleet.collected_at })).toBeNull()
  })

  it('is fresh right after a heartbeat', () => {
    heartbeat({ when: NOW })
    const fleet = view()

    expect(fleet.stale).toBe(false)
    expect(fleet.collected_at).toEqual(NOW)
    expect(ageSeconds({ now: NOW, at: fleet.collected_at })).toBeLessThan(5)
  })

  it('goes stale after three missed ticks', () => {
    heartbeat({ when: ago(200) })

    expect(ageSeconds({ now: NOW, at: ago(200) })).toBeGreaterThan(STALE_AFTER_SECONDS)
    expect(view().stale).toBe(true)
  })

  // --- hosts and staleness ----------------------------------------------

  it('lists every configured host', () => {
    write({
      target: 'host:vermithor',
      when: NOW,
      samples: [
        gauge('load.1m', 0.46),
        gauge('mem.total_bytes', 16_642_768_896),
        gauge('mem.available_bytes', 11_000_000_000),
      ],
    })
    const fleet = view()

    expect(new Set(fleet.hosts.map((host) => host.name))).toEqual(
      new Set(['vermithor', 'meleys', 'syrax', 'vhagar', 'caraxes']),
    )
    const vermithor = hostNamed('vermithor')
    expect(vermithor.metrics['load.1m']).toBe(0.46)
    expect(vermithor.has_gpu).toBe(true)
  })

  it('marks a never-collected host as such', () => {
    const caraxes = hostNamed('caraxes')

    // "not collected" must be its own state, never an implied healthy zero
    expect(caraxes.collected).toBe(false)
    expect(caraxes.metrics).toEqual({})
  })

  it('flags a host whose slow-tier metrics are stale', () => {
    heartbeat({ when: NOW })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })
    write({ target: 'host:caraxes', when: ago(6 * HOUR), samples: [gauge('disk.percent', 42)] })
    const fleet = view()
    const caraxes = hostNamed('caraxes')

    // the collector is alive and the fast tier is current, so the fleet-wide
    // heartbeat flag reads fresh: only the per-host metric age catches the
    // slow tier that died six hours ago behind it
    expect(fleet.stale).toBe(false)
    expect(caraxes.collected).toBe(true)
    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeGreaterThan(5 * HOUR)
  })

  it('never reports a reading it cannot date', () => {
    // the slow tier (disk, temperatures) died a week ago while the fast tier
    // kept reporting. Samples live seven days and the age window is a day, so
    // the disk reading outlived the only thing that could date it: it dropped
    // out of metricAges, `metrics_stale` went false on the strength of the
    // fresh load reading, and the card printed a bare "Healthy" over a
    // seven-day-old disk number with no stale note anywhere.
    heartbeat({ when: NOW })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })
    write({
      target: 'host:caraxes',
      when: ago(7 * DAY),
      samples: [gauge('disk.volume1.used_percent', 42)],
    })
    const caraxes = hostNamed('caraxes')

    // the undatable value is absent, not reported as current
    expect(caraxes.metrics).not.toHaveProperty(['disk.volume1.used_percent'])
    expect(caraxes.metrics['load.1m']).toBe(0.1)
    // and what remains really is fresh, so saying so is not a lie
    expect(caraxes.metrics_stale).toBe(false)
    expect(caraxes.stalest_family_age_seconds).toBeLessThan(60)
  })

  it('dates every reading it reports', () => {
    // the invariant behind the case above, stated directly: `metrics` and the
    // age computation must always describe the same set. A metric visible to
    // one and invisible to the other is a value on the page with no age
    // accounted for anywhere.
    heartbeat({ when: NOW })
    const readings = [
      [0, 'load.1m'],
      [6 * HOUR, 'disk.volume1.used_percent'],
      [3 * DAY, 'temp.coretemp.package_c'],
      [7 * DAY, 'net.veth8a3f21.rx_bytes'],
    ] as const
    readings.forEach(([offset, metric]) =>
      write({ target: 'host:caraxes', when: ago(offset), samples: [gauge(metric, 1)] }),
    )
    const caraxes = hostNamed('caraxes')

    const window = ago(METRIC_AGE_WINDOW_SECONDS)
    const dated = metricAges({ connection: db, target: 'host:caraxes', since: window })
    expect(new Set(Object.keys(caraxes.metrics))).toEqual(new Set(Object.keys(dated)))
    expect(new Set(Object.keys(caraxes.metrics))).toEqual(
      new Set(['load.1m', 'disk.volume1.used_percent']),
    )
  })

  it('stops reporting a container removed days ago as up', () => {
    // same mechanism, different surface: container.<name>.up is a sample like
    // any other, so a container removed more than a day ago kept its last "1"
    // and the card kept rendering it "Up" indefinitely
    heartbeat({ when: NOW })
    write({ target: 'host:meleys', when: NOW, samples: [gauge('load.1m', 0.2)] })
    write({ target: 'host:meleys', when: ago(3 * DAY), samples: [gauge('container.oldapp.up', 1)] })
    const meleys = hostNamed('meleys')

    expect(meleys.metrics).not.toHaveProperty(['container.oldapp.up'])
  })

  it('marks a host whose every reading aged out as not collected', () => {
    // rows exist for this host, all of them older than the age window. That is
    // neither fresh nor never-collected, and the card's "no current readings"
    // copy is written for exactly this: not collected *now*.
    heartbeat({ when: NOW })
    write({ target: 'host:syrax', when: ago(3 * DAY), samples: [gauge('load.1m', 0.1)] })
    const syrax = hostNamed('syrax')

    expect(syrax.collected).toBe(false)
    expect(syrax.metrics).toEqual({})
    expect(syrax.metrics_stale).toBe(true)
    expect(syrax.stalest_family_age_seconds).toBeNull()
    expect(syrax.uptime_percent_24h).toBeNull()
  })

  it('gives a never-collected host no uptime', () => {
    // a host that was never checked is unknown, not a perfect uptime score
    expect(hostNamed('caraxes').uptime_percent_24h).toBeNull()
  })

  it('drops a metric source that stopped producing', () => {
    // a veth renamed by a container restart is written once and never again.
    // Counted forever it pins metrics_stale true on a healthy docker host and
    // walks stalest_family_age_seconds up to seven days.
    heartbeat({ when: NOW })
    write({
      target: 'host:vermithor',
      when: ago(3 * DAY),
      samples: [counter('net.veth8a3f21.rx_bytes', 12)],
    })
    write({ target: 'host:vermithor', when: NOW, samples: [gauge('load.1m', 0.4)] })
    const vermithor = hostNamed('vermithor')

    expect(vermithor.metrics_stale).toBe(false)
    expect(vermithor.stalest_family_age_seconds).toBeLessThan(60)
  })

  it('ignores a vanished source beside a live sibling', () => {
    // meleys, 2026-08-26: DSM brought up a VPN tun1000 for one hour, and its
    // two counters froze when it went away. The age window is a day and the
    // stale band is 45 minutes, so under a plain `min` over every metric those
    // two dead readings reported the host stale for the next 23 hours while
    // net.eth0.* beside them updated every 30 seconds.
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: ago(17 * HOUR),
      samples: [counter('net.tun1000.rx_bytes', 900)],
    })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [counter('net.eth0.rx_bytes', 12), gauge('load.1m', 0.4)],
    })
    const meleys = hostNamed('meleys')

    // the family is reporting, so the host is not stale on the strength of one
    // source that went away inside it
    expect(meleys.metrics_stale).toBe(false)
    expect(meleys.stalest_family_age_seconds).toBeLessThan(60)
    // and the dead counter is still a reading the monitor will hand back: it is
    // excluded from the staleness judgment, not hidden
    expect(meleys.metrics['net.tun1000.rx_bytes']).toBe(900)
  })

  it('still flags a family that went silent whole', () => {
    // the other half of the same rule. Ignoring a vanished source must not
    // ignore a probe that stopped: when every metric under `disk` is old, no
    // sibling is left to vouch for it and the host is stale.
    heartbeat({ when: NOW })
    write({
      target: 'host:caraxes',
      when: ago(6 * HOUR),
      samples: [gauge('disk.volume1.used_percent', 42), gauge('disk.volume1.total_bytes', 8)],
    })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed('caraxes')

    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeGreaterThan(5 * HOUR)
  })

  it('names the family that fell silent', () => {
    // the page prints this word. Without it the card blamed disk and
    // temperature whatever had actually stopped.
    heartbeat({ when: NOW })
    write({
      target: 'host:caraxes',
      when: ago(6 * HOUR),
      samples: [gauge('temp.coretemp.temp1', 44)],
    })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })

    expect(hostNamed('caraxes').stalest_family).toBe('temp')
  })

  // --- uptime -----------------------------------------------------------

  it('reports no uptime for a window the collector did not watch', () => {
    // the collector has been up for one round. Nothing observed the other 24
    // hours, and an empty incident history over unwatched hours is not proof
    // of uptime, so the honest answer is null, which the card reads as
    // "Unknown" rather than a perfect score.
    heartbeat({ when: NOW })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed('caraxes')

    expect(caraxes.collected).toBe(true)
    expect(caraxes.uptime_percent_24h).toBeNull()
  })

  it('scores uptime once the collector has watched the window', () => {
    // one unbroken run reaching back past the window: two rounds is enough to
    // express that, with a gap tolerance wide enough to admit the second
    heartbeat({ when: ago(25 * HOUR) })
    heartbeat({ when: NOW, gap: 2 * DAY })
    // and the host itself checked across that run, not merely the collector
    // ticking beside it. A round that recorded no check for this host observed
    // the fleet, not the host.
    watched({ target: 'host:caraxes', since: ago(25 * HOUR), until: NOW, gap: 2 * DAY })
    write({ target: 'host:caraxes', when: NOW, samples: [gauge('load.1m', 0.1)] })

    expect(hostNamed('caraxes').uptime_percent_24h).toBe(100)
  })

  it('reports no uptime for a host the collector stopped checking', () => {
    // a persistent spawn_error: ssh cannot be started, so no host check is
    // recorded, while the collector keeps ticking and the docker endpoints
    // beside it keep recording failures. The collector-wide coverage mark ran
    // on unbroken through hours in which not one host was observed, and scored
    // them a flawless 100%.
    heartbeat({ when: ago(25 * HOUR) })
    heartbeat({ when: NOW, gap: 2 * DAY })
    // checks for this host stop six hours ago; its readings are still inside
    // the age window, so the card is still showing numbers
    watched({
      target: 'host:caraxes',
      since: ago(25 * HOUR),
      until: ago(6 * HOUR),
      gap: 2 * DAY,
    })
    write({ target: 'host:caraxes', when: ago(6 * HOUR), samples: [gauge('load.1m', 0.1)] })
    const caraxes = hostNamed('caraxes')

    expect(caraxes.collected).toBe(true)
    expect(caraxes.uptime_percent_24h).toBeNull()
  })

  it('never reads a future timestamp as fresh', () => {
    // a clock that stepped backwards leaves rows stamped ahead of now. A
    // negative age clears every staleness threshold, so the page would show
    // frozen values and affirmatively call them current.
    const ahead = addSeconds({ at: NOW, seconds: 6 * HOUR })
    heartbeat({ when: ahead })
    write({ target: 'host:caraxes', when: ahead, samples: [gauge('load.1m', 0.1)] })

    // the half /health reads: the heartbeat's age is unknown, so it is stale
    expect(ageSeconds({ now: NOW, at: ahead })).toBeNull()
    expect(view().stale).toBe(true)

    const caraxes = hostNamed('caraxes')
    expect(caraxes.metrics_stale).toBe(true)
    expect(caraxes.stalest_family_age_seconds).toBeNull()
  })

  // --- needs attention --------------------------------------------------

  it('divides load by the cores it observed', () => {
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [
        ...Array.from({ length: 4 }, (_, index) => counter(`cpu${index}.user`, 1)),
        gauge('load.1m', 2),
      ],
    })
    const meleys = hostNamed('meleys')

    expect(meleys.cores).toBe(4)
    expect(meleys.load_per_core).toBe(0.5)
    expect(meleys.status).toBe('ok')
  })

  it('reports no load per core before the cpu rows arrive', () => {
    heartbeat({ when: NOW })
    write({ target: 'host:meleys', when: NOW, samples: [gauge('load.1m', 2)] })
    const meleys = hostNamed('meleys')

    // dividing by a guessed core count would invent a number
    expect(meleys.cores).toBeNull()
    expect(meleys.load_per_core).toBeNull()
  })

  it('warns on a nearly full volume', () => {
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [gauge('disk.volume1.used_percent', 94)],
    })

    expect(hostNamed('meleys').status).toBe('warn')
  })

  // --- disk -------------------------------------------------------------

  it('reports the volume free space and its mount', () => {
    // the card prints "{free} free" beside "/volume1 · of {total}", and both
    // facts belong to the monitor: the SPA must not hardcode which volume the
    // collector watches, nor derive free space from a rounded percentage
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [
        gauge('disk.volume1.used_percent', 62),
        gauge('disk.volume1.total_bytes', 8000),
        gauge('disk.volume1.available_bytes', 3000),
      ],
    })
    const meleys = hostNamed('meleys')

    expect(meleys.disk_available_bytes).toBe(3000)
    expect(meleys.disk_mount).toBe('/volume1')
  })

  it('reports absent free space as absent', () => {
    // a host that has not reported the reading, or was never collected at all,
    // carries null rather than a number invented from the percentage
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [gauge('disk.volume1.used_percent', 62)],
    })

    expect(hostNamed('meleys').disk_available_bytes).toBeNull()
    expect(hostNamed('caraxes').disk_available_bytes).toBeNull()
  })

  // --- containers -------------------------------------------------------

  it('serves containers as objects', () => {
    heartbeat({ when: NOW })
    write({
      target: 'host:meleys',
      when: NOW,
      samples: [
        gauge('container.plex.up', 1),
        gauge('container.plex.healthy', 1),
        gauge('container.plex.has_healthcheck', 1),
        gauge('container.radarr.up', 0),
        gauge('container.radarr.healthy', 0),
        gauge('container.radarr.has_healthcheck', 0),
      ],
    })

    expect(hostNamed('meleys').containers).toEqual([
      { name: 'plex', up: true, healthy: true, has_healthcheck: true },
      { name: 'radarr', up: false, healthy: false, has_healthcheck: false },
    ])
  })
})

describe('coreCount', () => {
  it('reads the count from the per-cpu rows', () => {
    // Counted, not declared. A declared 4 goes silently wrong the day a box is
    // replaced, and the fleet is not uniform to begin with.
    const metrics = {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`cpu${index}.user`, 1])),
      // the aggregate row must not be counted
      'cpu.total.user': 1,
    }

    expect(coreCount(metrics)).toBe(8)
  })

  it('is unknown before a host reports', () => {
    expect(coreCount({})).toBeNull()
    expect(coreCount({ 'load.1m': 0.4 })).toBeNull()
  })
})

describe('hostState', () => {
  it('never calls an uncollected host healthy', () => {
    expect(hostState({ collected: false, diskPercent: 1, loadPerCore: 0 })).toBe('unknown')
  })

  it('warns on a full volume or a loaded box', () => {
    expect(hostState({ collected: true, diskPercent: 91, loadPerCore: 0.1 })).toBe('warn')
    expect(hostState({ collected: true, diskPercent: 10, loadPerCore: 1.5 })).toBe('warn')
    expect(hostState({ collected: true, diskPercent: 10, loadPerCore: 0.1 })).toBe('ok')
  })

  it('is ok when a reading is simply absent', () => {
    // a missing metric is not a failing one
    expect(hostState({ collected: true, diskPercent: null, loadPerCore: null })).toBe('ok')
  })
})

describe('memoryUsedPercent', () => {
  it('uses available, not free', () => {
    // free excludes reclaimable page cache; on these boxes that reads as 95%
    // used on an idle machine
    expect(
      memoryUsedPercent({
        'mem.total_bytes': 1000,
        'mem.available_bytes': 250,
        'mem.free_bytes': 50,
      }),
    ).toBe(75)
  })

  it('is absent when either reading is', () => {
    expect(memoryUsedPercent({ 'mem.total_bytes': 1000 })).toBeNull()
    expect(memoryUsedPercent({ 'mem.available_bytes': 250 })).toBeNull()
    expect(memoryUsedPercent({})).toBeNull()
  })

  it('never divides by a zero total', () => {
    expect(memoryUsedPercent({ 'mem.total_bytes': 0, 'mem.available_bytes': 0 })).toBeNull()
  })
})
