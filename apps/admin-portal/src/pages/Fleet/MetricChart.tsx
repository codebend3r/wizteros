import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'
import type { MetricHostSeries, MetricUnit } from '@/lib/fleetApi'
import type { MetricCopy } from '@/pages/Fleet/metricCopy'
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
}

/** One second of the drawn line: every host's newest reading carried forward
    to `at`. */
type HeldSample = {
  readonly at: number
  readonly values: ReadonlyMap<string, number>
}

/** One row of the dataset Recharts draws: a moment, and every host's value at
    it. Host columns are prefixed so a host named "at" could not collide with
    the timestamp column. */
type ChartRow = Record<string, number | null>

const AT_KEY = 'at'

const hostKey = (name: string): string => `host:${name}`

const MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const
const CHART_HEIGHT = 230

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

// The line advances one point per second, whatever cadence the page polls the
// monitor at. The collector reads each host far more slowly than that, so the
// seconds between readings carry the last value forward and the line reads as
// a stair-step instead of freezing until the next reading lands.
const SAMPLE_EVERY_MS = 1000

// How much of the trail is kept. It exists to show the seconds between
// readings, and only at zooms where a second is more than a rounding error: an
// hour of it already outruns what a week-wide frame can resolve to a pixel.
const HELD_TRAIL_MS = 3_600_000

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
    }
  })

const unionTicks = (plots: readonly HostPlot[]): readonly number[] =>
  [...new Set(plots.flatMap((plot) => plot.points.map((point) => point.at)))].sort(
    (first, second) => first - second,
  )

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

/** One second's sample, or null when no host has a reading fresh enough to
    carry. A host whose newest reading has already outlived its hold limit is
    left out, so a collector that stopped ends the line rather than extending a
    flat one nothing observed. */
const heldAt = ({ plots, at }: { plots: readonly HostPlot[]; at: number }): HeldSample | null => {
  const values = plots.flatMap((plot) => {
    const newest = plot.points[plot.points.length - 1]
    const limit = holdLimit(plot.points)
    return !newest || limit === null || at - newest.at > limit
      ? []
      : [[plot.name, newest.value] as const]
  })
  return values.length > 0 ? { at, values: new Map(values) } : null
}

/** The readings plus the held samples, as one series per host.
 *
 * A real reading always wins the instant it lands on: the hold stands in for a
 * reading that has not arrived, and must never displace one that has.
 */
const withHeld = (
  plots: readonly HostPlot[],
  samples: readonly HeldSample[],
): readonly HostPlot[] =>
  plots.map((plot) => {
    const held = samples.flatMap((sample) => {
      const value = sample.values.get(plot.name)
      return value === undefined ? [] : [{ at: sample.at, value }]
    })
    const byTick = new Map([...held, ...plot.points].map((point) => [point.at, point.value]))
    const points = [...byTick]
      .sort(([first], [second]) => first - second)
      .map(([at, value]) => ({ at, value }))
    return { ...plot, points, byTick }
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
}: {
  points: readonly PlotPoint[]
  times: readonly number[]
}): readonly (number | null)[] => {
  const limit = holdLimit(points)
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
    const limit = holdLimit(plot.points)
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
  const columns = plots.map((plot) => carryForward({ points: plot.points, times }))
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

const timeExact = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

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

type Frame = {
  /** The frame's right edge. */
  readonly nowMs: number
  readonly samples: readonly HeldSample[]
}

/** The moving present and the per-second trail drawn up to it.
 *
 * One timer stamps both, which is the whole reason they live together. Read
 * from two intervals they raced: the newest sample was stamped a hair past the
 * right edge the other timer had just set, so the frame clipped it and the
 * line's tip sat a second behind the present for as long as the page was open.
 *
 * The timer owns the cadence and the payload only supplies the values, which is
 * why the plots are read back through a ref: keying the interval on them would
 * restart it on every refetch and shift the phase, so the chart would advance
 * at the poll rate again by the back door.
 */
const useFrame = ({
  plots,
  windowMs,
  now,
}: {
  plots: readonly HostPlot[]
  windowMs: number
  now: () => number
}): Frame => {
  const [frame, setFrame] = useState<Frame>(() => ({ nowMs: now(), samples: [] }))
  const latest = useRef(plots)
  useEffect(() => {
    latest.current = plots
  }, [plots])

  useEffect(() => {
    const timer = setInterval(() => {
      const at = now()
      const sample = heldAt({ plots: latest.current, at })
      setFrame((previous) => {
        // trimmed here as well as at draw time, so a tab left open on a wide
        // range holds a bounded trail rather than a week of seconds
        const kept = previous.samples.filter(
          (entry) => entry.at >= at - Math.min(windowMs, HELD_TRAIL_MS),
        )
        return { nowMs: at, samples: sample === null ? kept : [...kept, sample] }
      })
    }, SAMPLE_EVERY_MS)
    return () => clearInterval(timer)
  }, [now, windowMs])

  return frame
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
      <p className={styles.tooltipTime}>{timeExact(at)}</p>
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
  // The present and the trail drawn up to it advance together, once a second.
  const { nowMs, samples } = useFrame({ plots, windowMs: span, now })
  const drawn = useMemo(() => withHeld(plots, samples), [plots, samples])

  // The drawn frame is [now - window, now]: a reading that ages past the window
  // slides off the left edge, and the space between the newest reading and the
  // right edge is the honest rendering of "nothing this recent yet".
  const first = nowMs - span
  const inFrame = (point: PlotPoint): boolean => point.at >= first && point.at <= nowMs
  /** The same host with only the readings the current frame covers. */
  const clipToFrame = (plot: HostPlot): HostPlot => ({
    name: plot.name,
    seriesIndex: plot.seriesIndex,
    byTick: plot.byTick,
    points: plot.points.filter(inFrame),
  })
  const visiblePlots = drawn.map(clipToFrame)
  const visibleReadings = plots.map(clipToFrame)

  const rows = toRows(visiblePlots)

  // The axis is sized from what is on screen, not from the whole payload: a
  // spike that has already slid off the left edge must not keep the ceiling
  // high over a chart that no longer shows it. A fixed-scale unit ignores the
  // peak entirely.
  const peak = Math.max(
    0,
    ...visiblePlots.flatMap((plot) => plot.points.map((point) => point.value)),
  )
  const scale = metricScale({ unit, peak })

  // Everything that reports what was observed - the freshness readout, the
  // table - counts readings only. The held samples are one second apart by
  // construction and would report a cadence nothing collected at.
  const ticks = unionTicks(visibleReadings)

  // Whole seconds, because the frame advances in whole seconds: a readout with
  // more precision than the thing it measures reads as false precision.
  const newestTick = ticks[ticks.length - 1] ?? null
  const ageSeconds = newestTick === null ? null : Math.max(0, (nowMs - newestTick) / 1000)
  const ageLabel = ageSeconds === null ? null : `${Math.round(ageSeconds)} s`

  return (
    <div className={styles.chart}>
      <p className={styles.subtitle}>
        {copy.measure} over the last {rangeProse(windowMinutes)}. The line advances a point every
        second and holds the last reading between collector ticks, so a flat run means no new
        reading rather than steady load. A gap in a line is a span nothing was observed. Wide ranges
        arrive averaged into buckets, so a hole shorter than one bucket is averaged over rather than
        drawn as a gap.
      </p>

      {copy.note.length > 0 && <p className={styles.caveat}>{copy.note}</p>}

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
            data={[...rows]}
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
              tickFormatter={timeShort}
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
                activeDot={{ r: 4 }}
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
