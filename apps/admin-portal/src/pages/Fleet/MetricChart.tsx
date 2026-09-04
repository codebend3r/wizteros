import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'
import type { MetricHostSeries, MetricUnit } from '@/lib/fleetApi'
import { CHART_HEIGHT } from '@/pages/Fleet/chartFrame'
import { chartCaption, type MetricCopy } from '@/pages/Fleet/metricCopy'
import { metricScale, type MetricScale } from '@/pages/Fleet/metricScale'
import styles from '@/pages/Fleet/MetricChart.module.scss'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { rangeProse } from '@/stores/fleetPrefsStore'

type MetricChartProps = {
  readonly hosts: readonly MetricHostSeries[]
  readonly windowMinutes: number
  /** What the numbers mean, which is what picks the y axis and the number
      formatting. Comes from the same response as the numbers. */
  readonly unit: MetricUnit
  readonly copy: MetricCopy
  /** The clock, injectable so tests can pin the frame. */
  readonly now?: () => number
}

type PlotPoint = {
  readonly at: number
  readonly value: number
}

type HostPlot = {
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

const AT_KEY = 'at'

const hostKey = (name: string): string => `host:${name}`

const MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const

// Phone-safe on purpose. A wide fallback inflates the layout on a narrow
// screen before ResizeObserver runs, and the observer then measures the box
// its own fallback inflated: the wrong width locks itself in. From below, the
// first measurement can only grow.
const FALLBACK_WIDTH = 280

// A missed reading must render as a gap in the line, not a straight bridge
// pretending the host was observed. The collector's cadence is not hardcoded
// here; it is inferred from the readings themselves, so a config change on the
// monitor cannot silently turn real gaps into bridges.
const GAP_FACTOR = 2.5

// The frame advances once a second, whatever cadence the page polls the monitor
// at, and each host's newest reading is carried onto the new right edge with
// it. The collector reads each host far more slowly than that, so the tip of
// every line keeps moving between readings instead of freezing until the next
// one lands.
const FRAME_EVERY_MS = 1000

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

const toPlots = (hosts: readonly MetricHostSeries[]): readonly HostPlot[] =>
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
const stallLimit = (plots: readonly HostPlot[]): number | null => {
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
 * The cursor walks each host's points once alongside the shared timeline rather
 * than searching them per moment. A week-wide frame is thousands of moments
 * against thousands of points, and a search inside the walk would make
 * redrawing the chart quadratic once a second.
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
  let cursor = 0
  let carried: PlotPoint | undefined
  return times.map((at) => {
    while (cursor < points.length) {
      const point = points[cursor]
      if (point === undefined || point.at > at) break
      carried = point
      cursor += 1
    }
    if (carried === undefined) return null
    // A reading always stands at its own moment, hold limit or not: a host with
    // a single reading has no observed cadence to hold against, and returning
    // null there dropped it off the chart entirely.
    if (carried.at === at) return carried.value
    return limit !== null && at - carried.at <= limit ? carried.value : null
  })
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

const timeShort = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const dayShort = (at: number): string =>
  new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })

/** The inspected moment, to the second and carrying its date.
 *
 * Every range past a day holds each wall-clock time several times over, so a
 * time alone names a moment the reader cannot place: 07:51 PM on which of the
 * seven days a week-wide frame is showing?
 */
const stampExact = (at: number): string =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const QUARTER_HOUR_MS = 900_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WIDEST_TICK_STEP_MS = 7 * DAY_MS

/** The spacings the x axis may label at, narrowest first.
 *
 * Every one is a whole number of quarter hours, which is what keeps a tick on
 * :00, :15, :30 or :45 rather than on whatever second the frame happened to
 * start at. Recharts' own tick picker divides the domain instead, so it labels
 * the moving present's offset - 07:23, 07:38 - and the labels shuffle every
 * second as the frame slides.
 */
const TICK_STEPS_MS = [
  QUARTER_HOUR_MS,
  2 * QUARTER_HOUR_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  WIDEST_TICK_STEP_MS,
] as const

/** What one label needs across, its text plus the space that keeps two labels
    from touching. */
const TICK_LABEL_PX = 76

/** The narrowest allowed spacing whose labels still fit the measured box, so a
    phone drops to hourly ticks where a desktop can carry quarter hours. */
const tickStep = ({ span, width }: { span: number; width: number }): number => {
  const budget = Math.max(2, Math.floor(width / TICK_LABEL_PX))
  return TICK_STEPS_MS.find((step) => span / step + 1 <= budget) ?? WIDEST_TICK_STEP_MS
}

/** Every boundary of the chosen spacing that falls inside the frame.
 *
 * Aligned against local midnight rather than the epoch, which is UTC midnight:
 * in a zone offset by a half hour the epoch's hours land on :30, and the axis
 * would promise quarter hours while labelling :07 and :22. Stepping on from
 * the first aligned tick keeps the rest aligned through a daylight-saving
 * shift too, because every zone shifts by a whole number of quarter hours.
 */
const axisTicks = ({
  first,
  last,
  step,
}: {
  first: number
  last: number
  step: number
}): readonly number[] => {
  const offset = new Date(first).getTimezoneOffset() * 60_000
  const start = Math.ceil((first - offset) / step) * step + offset
  const count = Math.max(0, Math.floor((last - start) / step) + 1)
  return Array.from({ length: count }, (_, index) => start + index * step)
}

/** A tick's label: the date once the ticks stand a day or more apart, where
    every one of them would otherwise read midnight. */
const axisLabel = ({ at, step }: { at: number; step: number }): string =>
  step >= DAY_MS ? dayShort(at) : timeShort(at)

/** The rendered width of the chart's box, tracked so the chart draws in real
    pixels: hairlines stay hairlines and label text never scales with a viewBox.
    Falls back to a fixed width where ResizeObserver cannot measure.

    Measured here rather than handed to Recharts' own ResponsiveContainer, which
    renders nothing at all inside a box reporting zero size - every one of this
    chart's tests among them. */
const useMeasuredWidth = (): { ref: RefObject<HTMLDivElement | null>; width: number } => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** The moving present: the frame's right edge, and the moment every line's tip
 * is carried to.
 *
 * One number from one timer, which is the whole point. Read from two clocks
 * they raced: a tip stamped a hair past the right edge the other had just set
 * was clipped straight back off, and the line sat a second behind the present
 * for as long as the page was open.
 *
 * The timer owns the cadence and nothing else does, so it survives a refetch
 * untouched: keying it on the payload would restart it on every poll and shift
 * its phase, and the chart would advance at the poll rate again by the back
 * door.
 */
const useNow = (now: () => number): number => {
  const [nowMs, setNowMs] = useState(now)
  useEffect(() => {
    const timer = setInterval(() => setNowMs(now()), FRAME_EVERY_MS)
    return () => clearInterval(timer)
  }, [now])
  return nowMs
}

/** Everything the frame [nowMs - span, nowMs] draws. */
type DrawnFrame = {
  /** Mutable, because Recharts takes its data that way, and built here so the
      render does not have to copy it back out of a readonly one every pass. */
  readonly rows: ChartRow[]
  /** The lines as drawn: readings plus each host's carried present. */
  readonly lines: readonly HostPlot[]
  /** The same hosts with observations only, which is what the legend names and
      the freshness readout counts. A carried point is not a reading. */
  readonly readings: readonly HostPlot[]
  readonly ticks: readonly number[]
  readonly scale: MetricScale
}

/** The frame, derived in one pass and cached against the moment it draws.
 *
 * Once a second, when the frame actually slides - not once a render. The page
 * around this chart re-renders on its own polling, on a resize and on every
 * refetch that answers with what it already had, and rebuilding a few hundred
 * rows, a peak and a scale for a frame that has not moved is work nobody can
 * see.
 */
const drawFrame = ({
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
  const clipToFrame = (plot: HostPlot): HostPlot => ({
    ...plot,
    points: plot.points.filter((point) => point.at >= first && point.at <= nowMs),
  })
  const lines = withHeld({ plots, at: nowMs }).map(clipToFrame)
  // The axis is sized from what is on screen, not from the whole payload: a
  // spike that has already slid off the left edge must not keep the ceiling
  // high over a chart that no longer shows it. A fixed-scale unit ignores the
  // peak entirely.
  const peak = Math.max(0, ...lines.flatMap((plot) => plot.points.map((point) => point.value)))
  const readings = plots.map(clipToFrame)
  return {
    rows: [...toRows(lines)],
    lines,
    readings,
    ticks: unionTicks(readings),
    scale: metricScale({ unit, peak }),
  }
}

// Module-level so the default is one stable reference: an inline default would
// be a new function every render and reset the interval effect keyed on it each
// time.
const readClock = (): number => Date.now()

type TooltipRow = {
  readonly name: string
  readonly seriesIndex: number
  readonly value: number
}

type ReadingTooltipProps = {
  readonly scale: MetricScale
  readonly plots: readonly HostPlot[]
  /** Injected by Recharts when it clones this element, which is why they are
      optional here and nowhere else. */
  readonly active?: boolean
  readonly label?: string | number
}

/** Every host's reading at the inspected moment.
 *
 * Written rather than taking Recharts' default so the series key stays the same
 * swatch the legend and the host cards use, and so values print through the
 * scale's formatter instead of raw. Only real readings are listed: the held
 * seconds between them are a drawing device, not observations.
 */
const ReadingTooltip = ({ scale, plots, active, label }: ReadingTooltipProps) => {
  const at = typeof label === 'number' ? label : null
  const rows: readonly TooltipRow[] =
    at === null
      ? []
      : plots.flatMap((plot) => {
          const value = plot.byTick.get(at)
          return value === undefined
            ? []
            : [{ name: plot.name, seriesIndex: plot.seriesIndex, value }]
        })
  // a break row carries no reading behind it, and an empty tooltip is noise
  if (active !== true || at === null || rows.length === 0) return null
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTime}>{stampExact(at)}</p>
      <ul className={styles.tooltipRows}>
        {rows.map((row) => (
          <li key={row.name} className={styles.tooltipRow}>
            <span
              className={`${styles.seriesKey} ${seriesClass(row.seriesIndex)}`}
              aria-hidden="true"
            />
            <span className={styles.tooltipValue}>{scale.format(row.value)}</span>
            <span className={styles.tooltipName}>{row.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const MetricChart = ({
  hosts,
  windowMinutes,
  unit,
  copy,
  now = readClock,
}: MetricChartProps) => {
  const { ref, width } = useMeasuredWidth()

  const plots = useMemo(() => toPlots(hosts), [hosts])
  const span = windowMinutes * 60_000
  const nowMs = useNow(now)
  const {
    rows,
    lines: visiblePlots,
    readings: visibleReadings,
    ticks,
    scale,
  } = useMemo(() => drawFrame({ plots, nowMs, span, unit }), [plots, nowMs, span, unit])

  const first = nowMs - span
  // Labelled at quarter-hour boundaries rather than wherever the domain
  // divides, so the ticks name round times and stay put while the frame slides
  // under them. The spacing widens with the range and narrows with the box.
  const step = tickStep({ span, width })
  const quarterHours = axisTicks({ first, last: nowMs, step })

  // Only worth saying once the collector is late. Readings land every few
  // seconds, so an always-on readout spends its life reporting the ordinary lag
  // between a reading and the frame that drew it - a number that reads as a
  // fault and is not one. Past the stall limit it is the opposite: the lines
  // have stopped, and this is the only thing on the page that says so.
  //
  // Whole seconds, because the frame advances in whole seconds: a readout with
  // more precision than the thing it measures reads as false precision.
  const newestTick = ticks[ticks.length - 1] ?? null
  const ageMs = newestTick === null ? null : Math.max(0, nowMs - newestTick)
  const stallAfterMs = stallLimit(visibleReadings)
  const ageLabel =
    ageMs !== null && stallAfterMs !== null && ageMs > stallAfterMs
      ? `${Math.round(ageMs / 1000)} s`
      : null

  return (
    <div className={styles.chart}>
      <p className={styles.subtitle}>{chartCaption({ copy, windowMinutes })}</p>

      {ageLabel !== null && <p className={styles.freshness}>Newest reading {ageLabel} ago.</p>}

      {ticks.length === 0 ? (
        <p className={styles.empty}>
          No {copy.reading} readings in the last {rangeProse(windowMinutes)}. The chart fills in as
          the collector ticks.
        </p>
      ) : (
        <div className={styles.plotWrap} ref={ref}>
          <LineChart
            width={width}
            height={CHART_HEIGHT}
            data={rows}
            margin={MARGIN}
            // Recharts' own keyboard layer: the chart takes a tab stop and the
            // arrow keys walk it, announcing each moment through the tooltip.
            accessibilityLayer
            role="img"
            aria-label={`${copy.title} by host over the last ${rangeProse(windowMinutes)}`}
          >
            <CartesianGrid className={styles.grid} vertical={false} />
            <XAxis
              dataKey={AT_KEY}
              type="number"
              scale="time"
              // the frame is the window, not the extent of the data: a host that
              // stopped reporting an hour ago leaves empty space to the right
              // rather than stretching to fill it
              domain={[first, nowMs]}
              allowDataOverflow
              ticks={[...quarterHours]}
              tickFormatter={(at: number) => axisLabel({ at, step })}
              // the label class rides the tick itself: Recharts hoists tick
              // text out of the axis group, where the axis class cannot
              // reach it
              tick={{ className: styles.tickLabel }}
              tickLine={false}
              minTickGap={width < 480 ? 64 : 40}
              className={styles.axis}
            />
            <YAxis
              type="number"
              domain={[0, scale.max]}
              ticks={[...scale.ticks]}
              tickFormatter={scale.format}
              width={scale.axisWidth}
              tick={{ className: styles.tickLabel }}
              tickLine={false}
              axisLine={false}
              className={styles.axis}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ className: styles.crosshair }}
              content={<ReadingTooltip scale={scale} plots={plots} />}
            />
            {visiblePlots.map((plot) => (
              <Line
                key={plot.name}
                // the class carries --series-color, which the stroke reads: one
                // colour per host position, the same one its card wears
                className={seriesClass(plot.seriesIndex)}
                dataKey={hostKey(plot.name)}
                name={plot.name}
                // monotone, so the curve cannot overshoot the range its own
                // readings span: a smoothed monitor line may not draw a trough
                // under two equal readings or a peak past a busy host's 100%
                type="monotone"
                stroke="var(--series-color, currentColor)"
                strokeWidth={2}
                // A stroke cannot show a reading with no neighbour to reach
                // toward, so a host down to a point or two wears dots instead.
                // Any host reporting normally has hundreds, and dots at that
                // density would smear the line into a band.
                dot={plot.points.length <= 2}
                // The inspected reading wears its series colour ringed in the
                // surface colour. The class comes along because the active dot
                // is drawn outside the line's group: without it the colour
                // variable never resolves and the dot renders bare white.
                activeDot={{
                  r: 4,
                  className: seriesClass(plot.seriesIndex),
                  stroke: 'var(--color-surface)',
                  strokeWidth: 2,
                }}
                // a span nothing observed stays a hole
                connectNulls={false}
                // the chart redraws once a second; an entrance animation would
                // restart on every one of them and never finish
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </div>
      )}

      <ul className={styles.legend}>
        {visibleReadings.map((plot) => (
          <li key={plot.name} className={styles.legendItem}>
            <span
              className={`${styles.seriesKey} ${seriesClass(plot.seriesIndex)}`}
              aria-hidden="true"
            />
            <span>{plot.name}</span>
            {plot.points.length === 0 && <span className={styles.legendNote}>no readings</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
