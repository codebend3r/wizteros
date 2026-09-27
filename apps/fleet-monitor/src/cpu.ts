// Aggregate CPU busy percent, derived from the raw jiffy counters.
//
// /proc/stat reports monotonic jiffy counters, not utilization, so a percentage
// only exists between two readings: the share of elapsed jiffies that were not
// idle. The derivation lives server-side with the other fleet judgments: the
// browser gets percentages, never counters.

import { CPU_FIELDS } from '@/probes/proc.js'
import { pythonRound } from '@/pythonMath.js'
import type { Series } from '@/store.js'

// What the busy derivation reads back: exactly the aggregate-row metrics
// parseStat writes, named from the same field list so the two cannot drift.
export const METRICS: readonly string[] = CPU_FIELDS.map((field) => `cpu.total.${field}`)

// iowait counts as not-busy alongside idle: it is time the CPU spent waiting
// for the disks, and counting it as busy would paint a disk-bound NAS as
// compute-bound.
const IDLE_METRICS: ReadonlySet<string> = new Set(['cpu.total.idle', 'cpu.total.iowait'])

// One reading of the aggregate row: when it was taken, the sum of every field
// it carried, the not-busy share of that sum, and how many fields went into it.
type Tick = Readonly<{
  at: Date
  total: number
  idle: number
  fields: number
}>

// A tick while it is being summed: idle stays null until an idle metric has
// been seen at that instant.
type Summing = Readonly<{
  at: Date
  total: number
  idle: number | null
  fields: number
}>

/**
 * Pivot per-metric series into per-timestamp jiffy sums.
 *
 * A timestamp with no idle reading is excluded outright: without idle there is
 * no not-busy share to subtract, so the tick cannot be judged and the series
 * bridges across it instead.
 */
const ticks = (seriesByMetric: Readonly<Record<string, Series>>): readonly Tick[] => {
  // keyed by the instant rather than the Date, since two Dates for the same
  // moment are different Map keys
  const sums = Object.entries(seriesByMetric).reduce(
    (byInstant, [metric, points]) =>
      points.reduce((summed, [at, value]) => {
        const held = summed.get(at.getTime())
        const heldIdle = held?.idle ?? null
        return summed.set(at.getTime(), {
          at: held?.at ?? at,
          total: (held?.total ?? 0) + value,
          idle: IDLE_METRICS.has(metric) ? (heldIdle ?? 0) + value : heldIdle,
          fields: (held?.fields ?? 0) + 1,
        })
      }, byInstant),
    new Map<number, Summing>(),
  )
  return [...sums.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, { at, total, idle, fields }]): readonly Tick[] =>
      idle === null ? [] : [{ at, total, idle, fields }],
    )
}

/**
 * Busy percent across one pair of ticks, or null when the pair is unusable.
 *
 * Three ways a pair lies and is dropped instead: a counter that went backwards
 * (a reboot zeroed /proc/stat; rendered anyway it would be a spike that never
 * happened), no elapsed jiffies at all, and a tick that recorded a different
 * set of fields than its neighbor, which skews the total delta by whatever the
 * missing counters advanced.
 */
const busyPercent = ({ previous, current }: { previous: Tick; current: Tick }): number | null => {
  const deltaTotal = current.total - previous.total
  const deltaIdle = current.idle - previous.idle
  if (previous.fields !== current.fields) {
    return null
  }
  if (deltaTotal <= 0 || deltaIdle < 0 || deltaIdle > deltaTotal) {
    return null
  }
  return pythonRound({ value: 100 * (1 - deltaIdle / deltaTotal), digits: 1 })
}

/**
 * The aggregate busy-percent series behind one host's cpu.total counters.
 *
 * Each point is stamped at the later reading of its pair and describes the
 * interval since the earlier one. Unusable pairs are dropped, not
 * interpolated: this is a monitor, and a gap is the honest rendering of a gap.
 */
export const busySeries = (seriesByMetric: Readonly<Record<string, Series>>): Series => {
  const readings = ticks(seriesByMetric)
  return readings.slice(1).flatMap((current, index): Series => {
    const value = busyPercent({ previous: readings[index], current })
    return value === null ? [] : [[current.at, value]]
  })
}
