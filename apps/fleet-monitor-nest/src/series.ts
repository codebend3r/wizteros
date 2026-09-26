// Every chartable history the dashboard draws, as one shape.
//
// Four questions, four different pieces of arithmetic: CPU busy comes out of
// jiffy counters, memory out of two gauges read against each other, GPU out of a
// frequency ratio, network out of byte counters. The page draws all four the same
// way, so they leave here as the same thing: a per-host series of (moment,
// value), plus a unit naming what the numbers mean.
//
// The derivations live here rather than in the browser for the same reason the
// host judgments do: they need to know what the collector collects. Which volume
// is watched, which meminfo keys carry the truth about used memory, that a GPU
// frequency is a load proxy and not a utilization percent: none of that is
// knowable a wire away.

import { HOSTS } from '@/config.js'
import { METRICS as CPU_METRICS, busySeries } from '@/cpu.js'
import type { Connection } from '@/db.js'
import { metricSeries, metricSeriesPrefix, rateSeries, type Series } from '@/store.js'
import { addSeconds, secondsBetween } from '@/time.js'
import { floorDivide, pythonRound, pythonSum } from '@/pythonMath.js'

// A series carries one point per collector tick, so a long window is thousands
// of them per host: a week at the vitals cadence is 20k points no chart can draw
// and no browser wants to parse. Anything longer than this is bucketed down.
export const MAX_POINTS = 720

// Memory is judged against MemAvailable rather than MemFree: free excludes
// reclaimable page cache, and on these boxes that reads as 95% used on an idle
// machine. Both keys are what probes.proc writes, named from there.
export const MEMORY_TOTAL_METRIC = 'mem.total_bytes'
export const MEMORY_AVAILABLE_METRIC = 'mem.available_bytes'

// The i915 actual-frequency share of the card's ceiling. DSM ships no
// intel_gpu_top and does not expose the i915 perf interface, so a true busy
// percentage is not obtainable on this fleet; this is a load proxy and the page
// has to say so rather than print it as utilization.
export const GPU_RATIO_METRIC = 'gpu.freq_ratio'

// Every per-interface byte counter probes.proc kept: loopback, tunnels, the
// docker bridges and the veth pairs are already dropped there, so what remains
// is the physical NICs. Measured 2026-08-26: meleys has eth0/eth1/eth2,
// vermithor and vhagar eth0/eth1, and none of the five runs a bond, so summing
// every interface cannot double-count a bond against its own members.
export const NETWORK_PREFIX = 'net.'

export type Unit = 'percent' | 'bytes_per_second'

export type Kind = 'cpu' | 'memory' | 'gpu' | 'network'

/**
 * One chartable metric family: what to read, and how to reduce it.
 *
 * `metrics` names the members when they are known ahead of time; `prefix`
 * discovers them per host instead, for a family whose membership is a
 * property of the box rather than of this code.
 */
export type Family = Readonly<{
  kind: Kind
  unit: Unit
  metrics: readonly string[]
  prefix: string
  derive: (seriesByMetric: Readonly<Record<string, Series>>) => Series
}>

// A series keyed by its instants rather than its Dates, since two Dates for the
// same moment are different Map keys. A repeated instant keeps its last
// reading, as dict() does.
const byInstant = (points: Series): ReadonlyMap<number, readonly [Date, number]> =>
  new Map(points.map((point) => [point[0].getTime(), point] as const))

/**
 * Used memory as a percentage, per tick.
 *
 * Both gauges come from one /proc/meminfo read, so they share a timestamp; a
 * moment carrying only one of them cannot be judged and is dropped rather
 * than paired with a neighbouring reading. A total of zero is not a full
 * machine, it is a bad read, and goes the same way.
 */
export const memoryUsedSeries = (seriesByMetric: Readonly<Record<string, Series>>): Series => {
  const totals = byInstant(seriesByMetric[MEMORY_TOTAL_METRIC] ?? [])
  const available = byInstant(seriesByMetric[MEMORY_AVAILABLE_METRIC] ?? [])
  return [...totals.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([instant, [at, total]]): Series => {
      const free = available.get(instant)?.[1] ?? null
      if (!(total > 0) || free === null || !(free >= 0 && free <= total)) {
        return []
      }
      return [[at, pythonRound({ value: ((total - free) / total) * 100, digits: 1 })]]
    })
}

/**
 * The GPU's frequency share of its own ceiling, as a percentage.
 *
 * Not utilization. A card can sit at its floor frequency while busy and at
 * its ceiling while barely working, so this says how hard the card is being
 * clocked, which is the only GPU signal these boxes expose.
 *
 * Clamped at the top rather than dropped: a card reporting above its own
 * stated maximum is pegged, and rendering that as a missing reading would
 * hide the one moment worth seeing. Below zero is not a reading at all.
 */
export const gpuLoadSeries = (seriesByMetric: Readonly<Record<string, Series>>): Series =>
  (seriesByMetric[GPU_RATIO_METRIC] ?? []).flatMap(([at, ratio]): Series =>
    ratio >= 0 ? [[at, pythonRound({ value: Math.min(ratio, 1) * 100, digits: 1 })]] : [],
  )

/**
 * Total bytes per second across every interface, received plus sent.
 *
 * Counters become rates through `rateSeries` in the store, which drops the
 * pair either side of a reboot rather than rendering the reset as a spike.
 * Every interface is read from one /proc/net/dev per tick, so the
 * per-interface rates share timestamps and sum cleanly.
 *
 * An interface that appears or disappears mid-window changes what the sum
 * covers, which is a real change in what the box has rather than an artifact
 * to correct for. A veth would be the exception, and those never reach here:
 * probes.proc drops them before they are ever stored.
 */
export const networkThroughputSeries = (
  seriesByMetric: Readonly<Record<string, Series>>,
): Series => {
  // keyed by the instant, as in memoryUsedSeries, and summed interface by
  // interface in the order the store handed them over, so the float additions
  // happen in the order Python made them
  const totals = Object.values(seriesByMetric).reduce(
    (summed, points) =>
      rateSeries(points).reduce((running, [at, value]) => {
        const held = running.get(at.getTime())
        return running.set(at.getTime(), [held?.[0] ?? at, (held?.[1] ?? 0) + value])
      }, summed),
    new Map<number, readonly [Date, number]>(),
  )
  return [...totals.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, [at, total]]) => [at, pythonRound({ value: total, digits: 1 })] as const)
}

export const FAMILIES: Readonly<Record<Kind, Family>> = {
  cpu: {
    kind: 'cpu',
    unit: 'percent',
    metrics: CPU_METRICS,
    prefix: '',
    derive: busySeries,
  },
  memory: {
    kind: 'memory',
    unit: 'percent',
    metrics: [MEMORY_TOTAL_METRIC, MEMORY_AVAILABLE_METRIC],
    prefix: '',
    derive: memoryUsedSeries,
  },
  gpu: {
    kind: 'gpu',
    unit: 'percent',
    metrics: [GPU_RATIO_METRIC],
    prefix: '',
    derive: gpuLoadSeries,
  },
  network: {
    kind: 'network',
    unit: 'bytes_per_second',
    metrics: [],
    prefix: NETWORK_PREFIX,
    derive: networkThroughputSeries,
  },
}

const KINDS: readonly Kind[] = ['cpu', 'memory', 'gpu', 'network']

const isKind = (value: string): value is Kind => KINDS.some((kind) => kind === value)

/**
 * The series thinned to at most `maxPoints` by averaging over fixed
 * buckets. Returned unchanged when it is already short enough.
 *
 * Each bucket keeps the timestamp of its own last reading rather than a
 * bucket edge, so every point still names a moment the host was really read,
 * and the value stays what the raw points are: the reading for the interval
 * ending there. An empty bucket contributes nothing, so a hole longer than a
 * bucket survives as a hole rather than being averaged over; a shorter one
 * does not, which is the trade a week-wide view makes for being drawable at
 * all.
 */
export const downsample = ({
  series,
  since,
  until,
  maxPoints = MAX_POINTS,
}: {
  series: Series
  since: Date
  until: Date
  maxPoints?: number
}): Series => {
  if (series.length <= maxPoints) {
    return series
  }
  const width = Math.max(secondsBetween({ from: since, to: until }) / maxPoints, 1)
  const buckets = series.reduce((byIndex, point) => {
    const index = floorDivide({
      dividend: secondsBetween({ from: since, to: point[0] }),
      divisor: width,
    })
    const points = byIndex.get(index) ?? []
    points.push(point)
    return byIndex.set(index, points)
  }, new Map<number, (readonly [Date, number])[]>())
  return [...buckets.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, points]): Series => {
      const last = points.at(-1)
      if (last === undefined) {
        return []
      }
      const mean = pythonSum(points.map(([, value]) => value)) / points.length
      return [[last[0], pythonRound({ value: mean, digits: 1 })]]
    })
}

/**
 * One target's series for one family, derived and thinned to fit a chart.
 *
 * A target that reported none of the family's metrics comes back empty rather
 * than as zeros: three of the five boxes have no render node at all, and a
 * flat line along the axis would claim an idle GPU where there is no GPU.
 */
export const history = ({
  connection,
  family,
  target,
  since,
  until,
}: {
  connection: Connection
  family: Family
  target: string
  since: Date
  until: Date
}): Series => {
  const raw = family.prefix
    ? metricSeriesPrefix({ connection, target, prefix: family.prefix, since })
    : metricSeries({ connection, target, metrics: family.metrics, since })
  return downsample({ series: family.derive(raw), since, until })
}

export type MetricPoint = Readonly<{
  at: Date
  value: number
}>

export type MetricHostSeries = Readonly<{
  name: string
  points: readonly MetricPoint[]
}>

/**
 * One metric family's history for the whole fleet.
 *
 * `kind` and `unit` travel with the numbers because the chart that draws them
 * is one component for all four: without the unit it cannot know whether 40
 * means 40 percent of a fixed scale or 40 bytes a second on a scale it has to
 * derive from the data.
 */
export type MetricHistoryView = Readonly<{
  kind: Kind
  unit: Unit
  window_minutes: number
  hosts: readonly MetricHostSeries[]
}>

/**
 * One metric family's history for every configured host.
 *
 * Hosts arrive in HOSTS order, the same order `/fleet` uses. The portal binds
 * one color per host by array position (on the cards from `/fleet`, on the
 * charts from here), so the responses must never disagree about position.
 *
 * A host with no readings in the window has an empty series, not zeros: the
 * chart renders that host as a legend entry with no line, which is the honest
 * rendering of "not observed". Three of the five boxes have no render node at
 * all, so on the GPU chart that is the normal case rather than a fault.
 *
 * A window wide enough to hold more ticks than a chart can draw comes back
 * bucketed; see downsample. Every host is bucketed against the same window,
 * so the thinning cannot put two hosts on different time bases.
 *
 * `kind` is a plain string, as it was in Python, and one no family carries
 * throws, as the dict lookup raised KeyError there.
 */
export const fleetHistory = ({
  connection,
  kind,
  minutes,
  now,
}: {
  connection: Connection
  kind: string
  minutes: number
  now: Date
}): MetricHistoryView => {
  if (!isKind(kind)) {
    throw new RangeError(`no metric family named ${kind}`)
  }
  const family = FAMILIES[kind]
  const since = addSeconds({ at: now, seconds: -minutes * 60 })
  return {
    kind: family.kind,
    unit: family.unit,
    window_minutes: minutes,
    hosts: HOSTS.map((host): MetricHostSeries => ({
      name: host.name,
      points: history({
        connection,
        family,
        target: `host:${host.name}`,
        since,
        until: now,
      }).map(([at, value]): MetricPoint => ({ at, value })),
    })),
  }
}
