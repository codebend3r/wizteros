import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import type { CpuHostSeries } from '@/lib/fleetApi'
import styles from '@/pages/Fleet/CpuChart.module.scss'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { rangeProse } from '@/stores/fleetPrefsStore'

type CpuChartProps = {
  readonly hosts: readonly CpuHostSeries[]
  readonly windowMinutes: number
  /** The clock, injectable so tests can pin the frame. */
  readonly now?: () => number
}

type PlotPoint = {
  readonly at: number
  readonly busy: number
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

// The layout the SVG is drawn into. The bottom margin exists for the x-axis
// labels: a fixed height that excluded them would clip the band or grow a
// nested scrollbar.
const MARGIN = { top: 12, right: 16, bottom: 28, left: 44 } as const
const PLOT_HEIGHT = 190
const CHART_HEIGHT = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom

// Phone-safe on purpose. A wide fallback inflates the layout on a narrow
// screen before ResizeObserver runs, and the observer then measures the box
// its own fallback inflated: the wrong width locks itself in. From below, the
// first measurement can only grow.
const FALLBACK_WIDTH = 280

const Y_TICKS = [0, 25, 50, 75, 100] as const

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
// Older than this the line is drawn straight between readings, as it was
// before the trail existed.
const HELD_TRAIL_MS = 3_600_000

const toPlots = (hosts: readonly CpuHostSeries[]): readonly HostPlot[] =>
  hosts.map((host, seriesIndex) => {
    const points = host.points
      .map((point) => ({ at: new Date(point.at).getTime(), busy: point.busy_percent }))
      .filter((point) => Number.isFinite(point.at))
    return {
      name: host.name,
      seriesIndex,
      points,
      byTick: new Map(points.map((point) => [point.at, point.busy])),
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

/** One host's points split wherever a reading is missing for long enough that
    drawing through would claim an observation that never happened. */
const toSegments = (
  points: readonly PlotPoint[],
  maxGap: number | null,
): readonly (readonly PlotPoint[])[] => {
  const starts = points.flatMap((point, index) => {
    const previous = points[index - 1]
    const breaksHere =
      index === 0 || (maxGap !== null && !!previous && point.at - previous.at > maxGap)
    return breaksHere ? [index] : []
  })
  return starts.map((start, startIndex) => points.slice(start, starts[startIndex + 1]))
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
      : [[plot.name, newest.busy] as const]
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
      const busy = sample.values.get(plot.name)
      return busy === undefined ? [] : [{ at: sample.at, busy }]
    })
    const byTick = new Map([...held, ...plot.points].map((point) => [point.at, point.busy]))
    const points = [...byTick]
      .sort(([first], [second]) => first - second)
      .map(([at, busy]) => ({ at, busy }))
    return { ...plot, points, byTick }
  })

const timeShort = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const timeExact = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** The rendered width of the chart's box, tracked so the SVG draws in real
    pixels: hairlines stay hairlines and label text never scales with a
    viewBox. Falls back to a fixed width where ResizeObserver cannot measure. */
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
 * The timer owns the cadence and the payload only supplies the values, which
 * is why the plots are read back through a ref: keying the interval on them
 * would restart it on every refetch and shift the phase, so the chart would
 * advance at the poll rate again by the back door.
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

// Module-level so the default is one stable reference: an inline default
// would be a new function every render and reset the interval effect keyed
// on it each time.
const readClock = (): number => Date.now()

type ReadingRow = {
  readonly plot: HostPlot
  readonly busy: number
}

const isReadingRow = (row: { plot: HostPlot; busy: number | undefined }): row is ReadingRow =>
  row.busy !== undefined

export const CpuChart = ({ hosts, windowMinutes, now = readClock }: CpuChartProps) => {
  const { ref, width } = useMeasuredWidth()
  const [cursor, setCursor] = useState<number | null>(null)

  const plots = useMemo(() => toPlots(hosts), [hosts])
  const span = windowMinutes * 60_000
  // The present and the trail drawn up to it advance together, once a second.
  const { nowMs, samples } = useFrame({ plots, windowMs: span, now })
  const drawn = useMemo(() => withHeld(plots, samples), [plots, samples])

  // The drawn frame is [now - window, now]: a reading that ages past the
  // window slides off the left edge, and the space between the newest reading
  // and the right edge is the honest rendering of "nothing this recent yet".
  const first = nowMs - span
  const inFrame = (point: PlotPoint): boolean => point.at >= first && point.at <= nowMs
  const visiblePlots = drawn.map((plot) => ({ ...plot, points: plot.points.filter(inFrame) }))
  const visibleReadings = plots.map((plot) => ({ ...plot, points: plot.points.filter(inFrame) }))

  // Everything that reports what was observed - the axis of inspectable
  // moments, the freshness readout, the table, the gap threshold - counts
  // readings only. The held samples are one second apart by construction, so
  // letting them into the threshold would turn every real spacing into a gap.
  const ticks = unionTicks(visibleReadings)
  const median = medianDelta(ticks)
  const maxGap = median === null ? null : median * GAP_FACTOR

  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 1)

  const x = (at: number): number => MARGIN.left + ((at - first) / span) * plotWidth
  const y = (busy: number): number => MARGIN.top + (1 - busy / 100) * PLOT_HEIGHT

  const toPath = (segment: readonly PlotPoint[]): string =>
    segment
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${x(point.at).toFixed(1)} ${y(point.busy).toFixed(1)}`,
      )
      .join(' ')

  // Clamped instead of cleared on refetch, so the inspected position survives
  // a payload that arrived with fewer readings.
  const cursorIndex = cursor === null ? null : Math.min(cursor, ticks.length - 1)
  const cursorTick = cursorIndex === null ? null : (ticks[cursorIndex] ?? null)

  const readings: readonly ReadingRow[] =
    cursorTick === null
      ? []
      : plots.map((plot) => ({ plot, busy: plot.byTick.get(cursorTick) })).filter(isReadingRow)

  const moveCursor = (next: number): void => {
    if (ticks.length > 0) setCursor(Math.max(0, Math.min(next, ticks.length - 1)))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = cursorIndex ?? ticks.length - 1
    const target = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      Home: 0,
      End: ticks.length - 1,
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    moveCursor(target)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const position = event.clientX - event.currentTarget.getBoundingClientRect().left
    const nearest = ticks.reduce(
      (best, tick, index) =>
        Math.abs(x(tick) - position) < Math.abs(x(ticks[best] ?? tick) - position) ? index : best,
      0,
    )
    if (ticks.length > 0) setCursor(nearest)
  }

  const xTickCount = width < 480 ? 3 : 5
  const xTicks = Array.from(
    { length: xTickCount },
    (_, index) => first + (span * index) / (xTickCount - 1),
  )

  // Whole seconds, because the frame now advances in whole seconds: a readout
  // with more precision than the thing it measures reads as false precision.
  const newestTick = ticks[ticks.length - 1] ?? null
  const ageSeconds = newestTick === null ? null : Math.max(0, (nowMs - newestTick) / 1000)
  const ageLabel = ageSeconds === null ? null : `${Math.round(ageSeconds)} s`

  const cursorLabel =
    cursorTick === null
      ? ''
      : `${timeExact(cursorTick)}: ${
          readings.map((row) => `${row.plot.name} ${row.busy}%`).join(', ') || 'no readings'
        }`

  return (
    <div className={styles.chart}>
      <p className={styles.subtitle}>
        Aggregate CPU busy percent per host over the last {rangeProse(windowMinutes)}. The line
        advances a point every second and holds the last reading between collector ticks, so a flat
        run means no new reading rather than steady load. A gap in a line is a span nothing was
        observed. Wide ranges arrive averaged into buckets, so a hole shorter than one bucket is
        averaged over rather than drawn as a gap.
      </p>

      {ageLabel !== null && <p className={styles.freshness}>Newest reading {ageLabel} ago.</p>}

      {ticks.length === 0 ? (
        <p className={styles.empty}>
          No CPU readings in the last {rangeProse(windowMinutes)}. The chart fills in as the
          collector ticks.
        </p>
      ) : (
        <div className={styles.plotWrap} ref={ref}>
          <svg
            className={styles.svg}
            width={width}
            height={CHART_HEIGHT}
            aria-hidden="true"
            focusable="false"
          >
            {Y_TICKS.map((tick) => (
              <g key={tick}>
                <line
                  className={styles.gridline}
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  className={styles.tickLabel}
                  x={MARGIN.left - 8}
                  y={y(tick) + 3}
                  textAnchor="end"
                >
                  {tick}%
                </text>
              </g>
            ))}
            {xTicks.map((tick, tickIndex) => (
              <text
                key={tick}
                className={styles.tickLabel}
                x={x(tick)}
                y={MARGIN.top + PLOT_HEIGHT + 18}
                // the outer labels hug their plot edge so neither clips against
                // the chart's own box
                textAnchor={
                  tickIndex === 0 ? 'start' : tickIndex === xTicks.length - 1 ? 'end' : 'middle'
                }
              >
                {timeShort(tick)}
              </text>
            ))}
            {visiblePlots.map((plot) =>
              toSegments(plot.points, maxGap).map((segment) =>
                segment.length > 1 ? (
                  <path
                    key={`${plot.name}-${segment[0]?.at ?? 0}`}
                    className={`${styles.line} ${seriesClass(plot.seriesIndex)}`}
                    d={toPath(segment)}
                  />
                ) : (
                  // a 2px stroke cannot show a lone reading; a ringed dot can
                  segment[0] && (
                    <circle
                      key={`${plot.name}-${segment[0].at}`}
                      className={`${styles.marker} ${seriesClass(plot.seriesIndex)}`}
                      cx={x(segment[0].at)}
                      cy={y(segment[0].busy)}
                      r={4}
                    />
                  )
                ),
              ),
            )}
            {visiblePlots.map((plot) => {
              const end = plot.points[plot.points.length - 1]
              return (
                !!end && (
                  <circle
                    key={plot.name}
                    className={`${styles.marker} ${seriesClass(plot.seriesIndex)}`}
                    cx={x(end.at)}
                    cy={y(end.busy)}
                    r={4}
                  />
                )
              )
            })}
            {cursorTick !== null && (
              <g>
                <line
                  className={styles.crosshair}
                  x1={x(cursorTick)}
                  x2={x(cursorTick)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + PLOT_HEIGHT}
                />
                {readings.map((row) => (
                  <circle
                    key={row.plot.name}
                    className={`${styles.marker} ${seriesClass(row.plot.seriesIndex)}`}
                    cx={x(cursorTick)}
                    cy={y(row.busy)}
                    r={4}
                  />
                ))}
              </g>
            )}
          </svg>

          {/* Which moment is being read is a value on a continuum, which is
            exactly what a slider is: arrow keys step it, and the value text
            reads out every host's number at that moment. */}
          <div
            className={styles.inspector}
            role="slider"
            tabIndex={0}
            aria-label="Reading time"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={ticks.length - 1}
            aria-valuenow={cursorIndex ?? ticks.length - 1}
            aria-valuetext={cursorLabel || 'no reading selected'}
            onKeyDown={onKeyDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setCursor(null)}
            onFocus={() => {
              if (cursorIndex === null) moveCursor(ticks.length - 1)
            }}
            onBlur={() => setCursor(null)}
          />

          {cursorTick !== null && (
            /* Anchored by `right` on the right half: an absolutely positioned
              box placed by `left` near the container's right edge shrinks to
              the sliver of space remaining and overflows it, which is where
              the clipped tooltip and the phantom scrollbar came from. */
            <div
              className={styles.tooltip}
              style={
                x(cursorTick) > width / 2
                  ? { right: `${width - x(cursorTick) + 8}px` }
                  : { left: `${x(cursorTick) + 8}px` }
              }
            >
              <p className={styles.tooltipTime}>{timeExact(cursorTick)}</p>
              <ul className={styles.tooltipRows}>
                {readings.map((row) => (
                  <li key={row.plot.name} className={styles.tooltipRow}>
                    <span
                      className={`${styles.seriesKey} ${seriesClass(row.plot.seriesIndex)}`}
                      aria-hidden="true"
                    />
                    <span className={styles.tooltipValue}>{row.busy}%</span>
                    <span className={styles.tooltipName}>{row.plot.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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

      {ticks.length > 0 && (
        <details className={styles.tableView}>
          <summary className={styles.tableSummary}>View as table</summary>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption>
                CPU busy percent by host, newest first, as the collector delivered it: the held
                seconds the line draws between readings are not rows here. -- marks a moment a host
                was not observed.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  {plots.map((plot) => (
                    <th key={plot.name} scope="col">
                      {plot.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ticks
                  .map((_, index) => ticks[ticks.length - 1 - index])
                  .map((tick) => (
                    <tr key={tick}>
                      <th scope="row">{timeExact(tick)}</th>
                      {plots.map((plot) => {
                        const busy = plot.byTick.get(tick)
                        return <td key={plot.name}>{busy === undefined ? '--' : `${busy}%`}</td>
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
