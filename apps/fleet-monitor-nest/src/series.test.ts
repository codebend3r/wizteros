import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOSTS } from '@/config.js'
import type { Connection } from '@/db.js'
import type { Sample } from '@/probes/types.js'
import {
  FAMILIES,
  MAX_POINTS,
  downsample,
  fleetHistory,
  gpuLoadSeries,
  memoryUsedSeries,
  networkThroughputSeries,
} from '@/series.js'
import { initDb, type Series, writeSamples } from '@/store.js'
import { openTestConnection, removeTempDirs } from '@/test/support.js'
import { addSeconds } from '@/time.js'

const T0 = new Date(Date.UTC(2026, 7, 23, 12, 0, 0))

const GB = 1024 ** 3

/** T0 moved by a number of seconds, the `_at` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

describe('FAMILIES', () => {
  it('declares either names or a prefix for every family', () => {
    // a family with neither would read nothing and draw an empty chart with no
    // error anywhere; with both, the prefix silently wins in history
    Object.values(FAMILIES).forEach((family) => {
      expect(family.metrics.length > 0, family.kind).not.toBe(!!family.prefix)
    })
  })

  it('keys each family by the kind it carries', () => {
    // the kind travels to the browser on every response, so a key that
    // disagreed with it would label one chart with another's name
    Object.entries(FAMILIES).forEach(([key, family]) => {
      expect(key).toBe(family.kind)
    })
  })
})

// --- memory ------------------------------------------------------------

describe('memoryUsedSeries', () => {
  it('judges used percent against available, not free', () => {
    const points = memoryUsedSeries({
      'mem.total_bytes': [
        [at(0), 16 * GB],
        [at(30), 16 * GB],
      ],
      'mem.available_bytes': [
        [at(0), 12 * GB],
        [at(30), 4 * GB],
      ],
    })

    expect(points).toEqual([
      [at(0), 25],
      [at(30), 75],
    ] satisfies Series)
  })

  it('drops a moment missing either gauge', () => {
    // both come from one /proc/meminfo read, so a moment carrying only one of
    // them is a bad read; pairing it with a neighbour would invent a reading
    const points = memoryUsedSeries({
      'mem.total_bytes': [
        [at(0), 8 * GB],
        [at(30), 8 * GB],
      ],
      'mem.available_bytes': [[at(30), 2 * GB]],
    })

    expect(points).toEqual([[at(30), 75]] satisfies Series)
  })

  it('drops a zero total rather than dividing by it', () => {
    // a total of zero is a bad read, not a full machine
    const points = memoryUsedSeries({
      'mem.total_bytes': [[at(0), 0]],
      'mem.available_bytes': [[at(0), 0]],
    })

    expect(points).toEqual([])
  })

  it('drops available above total', () => {
    const points = memoryUsedSeries({
      'mem.total_bytes': [[at(0), 8 * GB]],
      'mem.available_bytes': [[at(0), 9 * GB]],
    })

    expect(points).toEqual([])
  })

  it('is empty for a host that reported nothing', () => {
    expect(memoryUsedSeries({})).toEqual([])
  })
})

// --- gpu ---------------------------------------------------------------

describe('gpuLoadSeries', () => {
  it('reports the frequency ratio as a percentage', () => {
    const points = gpuLoadSeries({
      'gpu.freq_ratio': [
        [at(0), 0.1333],
        [at(30), 1],
      ],
    })

    expect(points).toEqual([
      [at(0), 13.3],
      [at(30), 100],
    ] satisfies Series)
  })

  it('clamps a card reporting past its own ceiling', () => {
    // pegged is a real state worth seeing; dropping it would hide the one
    // moment on the chart that mattered
    const points = gpuLoadSeries({ 'gpu.freq_ratio': [[at(0), 1.4]] })

    expect(points).toEqual([[at(0), 100]] satisfies Series)
  })

  it('drops a negative ratio', () => {
    expect(gpuLoadSeries({ 'gpu.freq_ratio': [[at(0), -0.5]] })).toEqual([])
  })

  it('is empty on a host with no render node', () => {
    // three of the five boxes have no /dev/dri at all; an empty series draws a
    // legend entry with no line rather than a flat line along the axis
    expect(gpuLoadSeries({})).toEqual([])
  })
})

// --- network -----------------------------------------------------------

describe('networkThroughputSeries', () => {
  it('sums every interface, received plus sent', () => {
    // 1000 bytes over 10s on each of four counters is 100 B/s each, 400 summed
    const counter: Series = [
      [at(0), 0],
      [at(10), 1000],
    ]
    const points = networkThroughputSeries({
      'net.eth0.rx_bytes': counter,
      'net.eth0.tx_bytes': counter,
      'net.eth1.rx_bytes': counter,
      'net.eth1.tx_bytes': counter,
    })

    expect(points).toEqual([[at(10), 400]] satisfies Series)
  })

  it('drops the pair a reboot zeroed', () => {
    // a counter that went backwards is a reset, and rendering the delta would
    // be a spike that never happened
    const points = networkThroughputSeries({
      'net.eth0.rx_bytes': [
        [at(0), 5000],
        [at(10), 10],
        [at(20), 1010],
      ],
    })

    expect(points).toEqual([[at(20), 100]] satisfies Series)
  })

  it('needs two readings before it can answer', () => {
    // a rate only exists between readings; one counter value is not a rate
    const points = networkThroughputSeries({ 'net.eth0.rx_bytes': [[at(0), 5000]] })

    expect(points).toEqual([])
  })

  it('is empty for a host that reported nothing', () => {
    expect(networkThroughputSeries({})).toEqual([])
  })
})

// --- downsample --------------------------------------------------------

describe('downsample', () => {
  it('leaves a short series alone', () => {
    const points: Series = Array.from({ length: 5 }, (_, index) => [at(index * 30), 10] as const)

    expect(downsample({ series: points, since: T0, until: at(150), maxPoints: 10 })).toEqual(points)
  })

  it('averages each bucket and dates it by its last reading', () => {
    // 4 readings over 4 seconds into 2 buckets: each point keeps a real
    // reading's timestamp, and its value is the mean of that bucket
    const points: Series = [
      [at(0), 10],
      [at(1), 20],
      [at(2), 50],
      [at(3), 60],
    ]

    expect(downsample({ series: points, since: T0, until: at(4), maxPoints: 2 })).toEqual([
      [at(1), 15],
      [at(3), 55],
    ] satisfies Series)
  })

  it('drops empty buckets instead of filling them', () => {
    // a hole wider than a bucket stays a hole: nothing is emitted for the
    // seconds nothing was read, so the chart still breaks the line there
    const points: Series = [
      [at(0), 10],
      [at(1), 20],
      [at(8), 30],
      [at(9), 40],
    ]

    expect(downsample({ series: points, since: T0, until: at(10), maxPoints: 3 })).toEqual([
      [at(1), 15],
      [at(9), 35],
    ] satisfies Series)
  })

  it("bounds a week's worth of ticks", () => {
    // a week of 30s ticks is 20k points; whatever the window, the answer stays
    // small enough for a browser to parse and an svg to draw
    const week = 7 * 24 * 3600
    const points: Series = Array.from(
      { length: week / 30 },
      (_, index) => [at(index * 30), 10] as const,
    )

    expect(downsample({ series: points, since: T0, until: at(week) }).length).toBeLessThanOrEqual(
      MAX_POINTS,
    )
  })

  // The two below have no Python counterpart. They pin the port to what the
  // Python served where JS arithmetic alone would part from it; both expected
  // answers were computed by running series.downsample itself.

  it('buckets a reading the way Python floor division does', () => {
    // a 10 second window in 6 buckets is 1.6666666666666667 wide, and the
    // reading at 5s is bucket 2 to Python's `//` but bucket 3 to Math.floor
    // of the quotient, which would have averaged it with the one at 6s instead
    const points: Series = [
      [at(0), 10],
      [at(1), 20],
      [at(2), 30],
      [at(4), 40],
      [at(5), 50],
      [at(6), 60],
      [at(9), 70],
    ]

    expect(downsample({ series: points, since: T0, until: at(10), maxPoints: 6 })).toEqual([
      [at(1), 15],
      [at(2), 30],
      [at(5), 45],
      [at(6), 60],
      [at(9), 70],
    ] satisfies Series)
  })

  it("averages a bucket with Python's compensated sum", () => {
    // summed left to right these four come to 54.150000000000006 over four,
    // which rounds to 54.2; Python's sum() carries the lost bits and lands on
    // the side of the tie that rounds to 54.1
    const points: Series = [
      [at(0), 94.9],
      [at(1), 14.9],
      [at(2), 88.5],
      [at(3), 18.3],
    ]

    expect(downsample({ series: points, since: T0, until: at(4), maxPoints: 1 })).toEqual([
      [at(3), 54.1],
    ] satisfies Series)
  })
})

// --- fleetHistory ------------------------------------------------------
//
// Python tested fleet_history only through its routes in test_api.py. These
// exercise it directly on a seeded database, from those same cases.

describe('fleetHistory', () => {
  let db: Connection

  beforeEach(() => {
    db = openTestConnection({ init: [initDb] })
  })

  afterEach(() => {
    db.close()
    removeTempDirs()
  })

  const NOW = new Date(Date.UTC(2026, 8, 26, 7, 0, 0))

  const ago = (seconds: number): Date => addSeconds({ at: NOW, seconds: -seconds })

  const write = ({
    target,
    when,
    samples,
  }: {
    target: string
    when: Date
    samples: readonly Sample[]
  }) => writeSamples({ connection: db, target, at: when, samples })

  const cpuTick = ({ user, idle }: { user: number; idle: number }): readonly Sample[] => [
    { metric: 'cpu.total.user', value: user, kind: 'counter' },
    { metric: 'cpu.total.idle', value: idle, kind: 'counter' },
  ]

  const valuesByHost = ({ kind, minutes = 60 }: { kind: string; minutes?: number }) =>
    Object.fromEntries(
      fleetHistory({ connection: db, kind, minutes, now: NOW }).hosts.map(
        (host) => [host.name, host.points.map((point) => point.value)] as const,
      ),
    )

  it('reports busy percent per host', () => {
    write({ target: 'host:meleys', when: ago(60), samples: cpuTick({ user: 0, idle: 0 }) })
    write({ target: 'host:meleys', when: ago(30), samples: cpuTick({ user: 25, idle: 75 }) })

    const view = fleetHistory({ connection: db, kind: 'cpu', minutes: 60, now: NOW })

    expect(view.window_minutes).toBe(60)
    expect(view.kind).toBe('cpu')
    expect(view.unit).toBe('percent')
    const meleys = view.hosts.find((host) => host.name === 'meleys')
    expect(meleys?.points ?? []).toEqual([{ at: ago(30), value: 25 }])
    // a host with no counters in the window has no points, not zeros
    expect(valuesByHost({ kind: 'cpu' }).vermithor).toEqual([])
  })

  it('lists hosts in the same order as /fleet, for every kind', () => {
    // one colour per host position, bound on the cards from /fleet and on every
    // chart from these; a kind disagreeing would recolour a whole chart
    const names = HOSTS.map((host) => host.name)
    const kinds = ['cpu', 'memory', 'gpu', 'network'] as const

    kinds.forEach((kind) => {
      const view = fleetHistory({ connection: db, kind, minutes: 60, now: NOW })
      expect(
        view.hosts.map((host) => host.name),
        kind,
      ).toEqual(names)
    })
  })

  it('honors the requested window', () => {
    write({ target: 'host:meleys', when: ago(10 * 60), samples: cpuTick({ user: 0, idle: 0 }) })
    write({ target: 'host:meleys', when: ago(9 * 60), samples: cpuTick({ user: 25, idle: 75 }) })

    const narrow = fleetHistory({ connection: db, kind: 'cpu', minutes: 5, now: NOW })

    expect(narrow.window_minutes).toBe(5)
    expect(narrow.hosts.map((host) => host.points)).toEqual([[], [], [], [], []])
    expect(valuesByHost({ kind: 'cpu', minutes: 30 }).meleys).toEqual([25])
  })

  it('reports used memory percent per host', () => {
    write({
      target: 'host:meleys',
      when: ago(30),
      samples: [
        { metric: 'mem.total_bytes', value: 16 * GB, kind: 'gauge' },
        { metric: 'mem.available_bytes', value: 4 * GB, kind: 'gauge' },
      ],
    })

    const view = fleetHistory({ connection: db, kind: 'memory', minutes: 60, now: NOW })

    expect(view.kind).toBe('memory')
    expect(view.unit).toBe('percent')
    const values = valuesByHost({ kind: 'memory' })
    expect(values.meleys).toEqual([75])
    // a host that reported no memory gauges has no points, not zeros
    expect(values.vermithor).toEqual([])
  })

  it('reports the gpu frequency ratio as a percentage', () => {
    write({
      target: 'host:vermithor',
      when: ago(30),
      samples: [{ metric: 'gpu.freq_ratio', value: 0.4, kind: 'gauge' }],
    })

    const view = fleetHistory({ connection: db, kind: 'gpu', minutes: 60, now: NOW })

    expect(view.kind).toBe('gpu')
    expect(view.unit).toBe('percent')
    const values = valuesByHost({ kind: 'gpu' })
    expect(values.vermithor).toEqual([40])
    // meleys has no render node at all, permanently: empty, never zero
    expect(values.meleys).toEqual([])
  })

  it('sums every interface for network', () => {
    write({
      target: 'host:meleys',
      when: ago(40),
      samples: [
        { metric: 'net.eth0.rx_bytes', value: 0, kind: 'counter' },
        { metric: 'net.eth1.tx_bytes', value: 0, kind: 'counter' },
      ],
    })
    write({
      target: 'host:meleys',
      when: ago(30),
      samples: [
        { metric: 'net.eth0.rx_bytes', value: 1000, kind: 'counter' },
        { metric: 'net.eth1.tx_bytes', value: 500, kind: 'counter' },
      ],
    })

    const view = fleetHistory({ connection: db, kind: 'network', minutes: 60, now: NOW })

    expect(view.kind).toBe('network')
    expect(view.unit).toBe('bytes_per_second')
    expect(valuesByHost({ kind: 'network' }).meleys).toEqual([150])
  })

  it('reads only this target and only net metrics for network', () => {
    // the prefix read is a range scan over the metric column, so a neighbouring
    // family (or another host's counters) must not fall inside it
    const ticks = [
      [40, 0],
      [30, 1000],
    ] as const

    ticks.forEach(([offset, value]) => {
      write({
        target: 'host:meleys',
        when: ago(offset),
        samples: [
          { metric: 'net.eth0.rx_bytes', value, kind: 'counter' },
          { metric: 'mem.total_bytes', value: 8 * GB, kind: 'gauge' },
          { metric: 'procs.total', value: 300, kind: 'gauge' },
        ],
      })
      write({
        target: 'host:vermithor',
        when: ago(offset),
        samples: [{ metric: 'net.eth0.rx_bytes', value: value * 9, kind: 'counter' }],
      })
    })

    const values = valuesByHost({ kind: 'network' })

    expect(values.meleys).toEqual([100])
    expect(values.vermithor).toEqual([900])
  })

  it('refuses a kind no family carries', () => {
    // the Python dict lookup raised KeyError here
    expect(() => fleetHistory({ connection: db, kind: 'disk', minutes: 60, now: NOW })).toThrow(
      RangeError,
    )
  })
})
