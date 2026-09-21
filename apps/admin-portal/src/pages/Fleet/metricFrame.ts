import type { ChartScale } from '@/components/Chart/chartScale'
import type { MetricHostSeries, MetricUnit } from '@/lib/fleetApi'
import { metricScale } from '@/pages/Fleet/metricScale'

type PlotPoint = {
  readonly at: number
  readonly value: number
}

export type HostPlot = {
  readonly name: string
  readonly seriesIndex: number
  readonly points: readonly PlotPoint[]
  readonly byTick: ReadonlyMap<number, number>
  /** How long this host's newest reading may be carried forward, read off the
      spacing of the readings themselves and carried from there.

      Measured once, on the way in, where the series is nothing but readings.
      Re-deriving it downstream measured a series that already carried the
      drawn present: those points sit a second apart, so the inferred cadence
      collapsed to a second, every real interval between readings was
      reclassified as a gap, and the line broke into points too sparse to draw.
      The chart went blank a few seconds after it painted. */
  readonly holdLimitMs: number | null
}

/** One row of the dataset Recharts draws: a moment, and every host's value at
    it. Host columns are prefixed so a host named "at" could not collide with
    the timestamp column. */
type ChartRow = Record<string, number | null>

export const AT_KEY = 'at'

export const hostKey = (name: string): string => `host:${name}`

// A missed reading must render as a gap in the line, not a straight bridge
// pretending the host was observed. The collector's cadence is not hardcoded
// here; it is inferred from the readings themselves, so a config change on the
// monitor cannot silently turn real gaps into bridges.
const GAP_FACTOR = 2.5

/** The typical spacing between readings, or null below two readings. */
const medianDelta = (ticks: readonly number[]): number | null => {
  const deltas = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick))
  if (deltas.length === 0) return null
  const sorted = [...deltas].sort((first, second) => first - second)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

/** How long one host's newest reading may be carried forward, inferred from
    that host's own spacing. null below two readings: with no observed cadence
    there is nothing to judge staleness against, so nothing is held. */
const holdLimit = (points: readonly PlotPoint[]): number | null => {
  const median = medianDelta(points.map((point) => point.at))
  return median === null ? null : median * GAP_FACTOR
}

/** The wire series as the frame reads them: epoch milliseconds, the host's
    palette position, and the cadence its own readings imply. */
export const toPlots = (hosts: readonly MetricHostSeries[]): readonly HostPlot[] =>
  hosts.map((host, seriesIndex) => {
    const points = host.points
      .map((point) => ({ at: new Date(point.at).getTime(), value: point.value }))
      .filter((point) => Number.isFinite(point.at))
    return {
      name: host.name,
      seriesIndex,
      points,
      byTick: new Map(points.map((point) => [point.at, point.value])),
      holdLimitMs: holdLimit(points),
    }
  })

/** Every moment any host was read at, in order and without repeats. */
const unionTicks = (plots: readonly HostPlot[]): readonly number[] =>
  [...new Set(plots.flatMap((plot) => plot.points.map((point) => point.at)))].sort(
    (first, second) => first - second,
  )

/** How long the chart may go without a reading before the silence is news.
 *
 * The most patient host's own hold limit, so the readout appears exactly when
 * the lines stop advancing and not a second before. null below two readings
 * anywhere, where there is no observed cadence to be late against.
 */
export const stallLimit = (plots: readonly HostPlot[]): number | null => {
  const limits = plots.flatMap((plot) => (plot.holdLimitMs === null ? [] : [plot.holdLimitMs]))
  return limits.length > 0 ? Math.max(...limits) : null
}

/** One host's newest reading carried onto the present, or null when there is
 * nothing fresh enough to carry.
 *
 * One point, at the frame's own right edge, rather than a trail of them: what
 * the line owes the reader is a tip that keeps moving between readings, and a
 * point per second bought nothing beyond that except a series that grew for as
 * long as the tab stayed open. A host whose newest reading has already outlived
 * its hold limit is left out, so a collector that stopped ends the line rather
 * than extending a flat one nothing observed.
 */
const heldPoint = ({ plot, at }: { plot: HostPlot; at: number }): PlotPoint | null => {
  const newest = plot.points[plot.points.length - 1]
  if (newest === undefined || plot.holdLimitMs === null) return null
  // strictly past the newest reading: a hold stands in for a reading that has
  // not arrived and must never displace one that has
  return at > newest.at && at - newest.at <= plot.holdLimitMs ? { at, value: newest.value } : null
}

/** The readings with the present drawn onto the end of each host's line.
 *
 * `byTick` is left alone on purpose: it answers what was observed, and the
 * tooltip reads it. The carried point is a drawing device, not an observation.
 */
const withHeld = ({ plots, at }: { plots: readonly HostPlot[]; at: number }): readonly HostPlot[] =>
  plots.map((plot) => {
    const held = heldPoint({ plot, at })
    return held === null ? plot : { ...plot, points: [...plot.points, held] }
  })

/** One host's value at every moment in `times`: carried forward between its own
 * readings, null past its hold limit.
 *
 * `times` is built from every host's readings, so each of this host's readings
 * is itself one of the moments: the readings cut the timeline into runs, one
 * per reading, and every moment in a run carries that reading until the hold
 * expires. Cutting once and mapping each run keeps the pass O(n + m), where
 * searching the readings per moment would make redrawing the chart quadratic
 * once a second.
 */
const carryForward = ({
  points,
  times,
  limit,
}: {
  points: readonly PlotPoint[]
  times: readonly number[]
  limit: number | null
}): readonly (number | null)[] => {
  const byMoment = new Map(points.map((point) => [point.at, point]))
  /** What the host stands at for one moment of the run one reading opens. */
  const held = ({ point, at }: { point: PlotPoint; at: number }): number | null =>
    // A reading always stands at its own moment, hold limit or not: a host with
    // a single reading has no observed cadence to hold against, and returning
    // null there dropped it off the chart entirely.
    point.at === at || (limit !== null && at - point.at <= limit) ? point.value : null
  const runs = times.flatMap((at, index) => {
    const point = byMoment.get(at)
    return point === undefined ? [] : [{ index, point }]
  })
  // Before the first reading the host has no value at all, which is not the
  // same as a value of zero.
  const unobserved = times.slice(0, runs[0]?.index ?? times.length).map(() => null)
  return [
    ...unobserved,
    ...runs.flatMap(({ index, point }, order) =>
      times.slice(index, runs[order + 1]?.index ?? times.length).map((at) => held({ point, at })),
    ),
  ]
}

/** A moment inside each of a host's gaps, so its line has somewhere to break.
 *
 * Recharts ends a line where a value is null, and a gap with no row inside it
 * has no null to end on: the readings either side get joined by one long
 * stroke claiming the host was observed the whole way across. Placed where the
 * hold expires rather than mid-gap, so the line stops exactly where the
 * evidence does.
 */
const gapBreaks = (plots: readonly HostPlot[]): readonly number[] =>
  plots.flatMap((plot) => {
    const limit = plot.holdLimitMs
    return limit === null
      ? []
      : plot.points.flatMap((point, index) => {
          const next = plot.points[index + 1]
          // one past the limit, because the hold covers the limit itself: a
          // break placed exactly on it still carries a value and joins the line
          const breakAt = point.at + limit + 1
          return next && next.at > breakAt ? [breakAt] : []
        })
  })

/** The dataset Recharts draws.
 *
 * Recharts plots one table with a column per series, so a moment has to carry a
 * value for every host or none. A host left undefined at another host's reading
 * time would break its line there, at a moment it was perfectly healthy - hence
 * the carry-forward. Past a host's hold limit its column is null and
 * `connectNulls={false}` breaks the line, which is the honest rendering of a
 * host that stopped reporting.
 */
const toRows = (plots: readonly HostPlot[]): readonly ChartRow[] => {
  const times = [...new Set([...unionTicks(plots), ...gapBreaks(plots)])].sort(
    (first, second) => first - second,
  )
  const columns = plots.map((plot) =>
    carryForward({ points: plot.points, times, limit: plot.holdLimitMs }),
  )
  /** Every host's column at one moment, keyed alongside the timestamp itself. */
  const entriesAt = (at: number, index: number): readonly (readonly [string, number | null])[] => [
    [AT_KEY, at],
    ...plots.map((plot, column): readonly [string, number | null] => [
      hostKey(plot.name),
      columns[column]?.[index] ?? null,
    ]),
  ]
  return times.map((at, index) => Object.fromEntries(entriesAt(at, index)))
}

/** Everything the frame [nowMs - span, nowMs] draws. */
export type DrawnFrame = {
  /** Mutable, because Recharts takes its data that way, and built here so the
      render does not have to copy it back out of a readonly one every pass. */
  readonly rows: ChartRow[]
  /** The lines as drawn: readings plus each host's carried present. */
  readonly lines: readonly HostPlot[]
  /** The same hosts with observations only, which is what the legend names and
      the freshness readout counts. A carried point is not a reading. */
  readonly readings: readonly HostPlot[]
  readonly ticks: readonly number[]
  readonly scale: ChartScale
}

/** The frame, derived in one pass and cached against the moment it draws.
 *
 * Once a second, when the frame actually slides - not once a render. The page
 * around this chart re-renders on its own polling, on a resize and on every
 * refetch that answers with what it already had, and rebuilding a few hundred
 * rows, a peak and a scale for a frame that has not moved is work nobody can
 * see.
 */
export const drawFrame = ({
  plots,
  nowMs,
  span,
  unit,
}: {
  plots: readonly HostPlot[]
  nowMs: number
  span: number
  unit: MetricUnit
}): DrawnFrame => {
  // The drawn frame is [now - window, now]: a reading that ages past the window
  // slides off the left edge, and the space between the newest reading and the
  // right edge is the honest rendering of "nothing this recent yet".
  const first = nowMs - span
  const inFrame = (point: PlotPoint): boolean => point.at >= first && point.at <= nowMs
  const clipToFrame = (plot: HostPlot): HostPlot => ({
    ...plot,
    points: plot.points.filter(inFrame),
  })
  // The newest reading before the left edge stays on the drawn line, so the
  // stroke enters from the edge instead of starting at the first reading
  // inside it: readings land a collector tick apart, and a line that began at
  // the first one left up to a tick of empty plot on the left. The x axis
  // allows overflow, so Recharts clips the stroke at the plot's edge and the
  // reading itself is never shown.
  const withLeadIn = (plot: HostPlot): HostPlot => {
    const before = plot.points.filter((point) => point.at < first)
    const lead = before[before.length - 1]
    return {
      ...plot,
      points: [...(lead === undefined ? [] : [lead]), ...plot.points.filter(inFrame)],
    }
  }
  const lines = withHeld({ plots, at: nowMs }).map(withLeadIn)
  const readings = plots.map(clipToFrame)
  // The axis is sized from what is on screen, not from the whole payload: a
  // spike that has already slid off the left edge must not keep the ceiling
  // high over a chart that no longer shows it, and the lead-in reading is off
  // screen by definition. A fixed-scale unit ignores the peak entirely.
  const peak = Math.max(0, ...readings.flatMap((plot) => plot.points.map((point) => point.value)))
  return {
    rows: [...toRows(lines)],
    lines,
    readings,
    ticks: unionTicks(readings),
    scale: metricScale({ unit, peak }),
  }
}
