import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartLegend } from '@/components/Chart/ChartLegend'
import { CHART_MARGIN, COLLAPSED_CHART_HEIGHT } from '@/components/Chart/chartFrame'
import { ChartTooltip, type ChartKeyRow } from '@/components/Chart/ChartTooltip'
import type { ChartScale } from '@/components/Chart/chartScale'
import type { MetricHostSeries, MetricUnit } from '@/lib/fleetApi'
import { chartCaption, type MetricCopy } from '@/pages/Fleet/metricCopy'
import {
  AT_KEY,
  drawFrame,
  hostKey,
  stallLimit,
  toPlots,
  type HostPlot,
} from '@/pages/Fleet/metricFrame'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import {
  axisLabel,
  DAY_MS,
  DAY_TIME_LABEL_PX,
  labelledTicks,
  stampExact,
  tickCap,
  TIME_LABEL_PX,
} from '@/pages/Fleet/timeAxis'
import { useMeasuredWidth } from '@/lib/useMeasuredWidth'
import { rangeProse } from '@/stores/fleetPrefsStore'
import chrome from '@/components/Chart/chart.module.scss'
import styles from '@/pages/Fleet/MetricChart.module.scss'

type MetricChartProps = {
  readonly hosts: readonly MetricHostSeries[]
  readonly windowMinutes: number
  /** What the numbers mean, which is what picks the y axis and the number
      formatting. Comes from the same response as the numbers. */
  readonly unit: MetricUnit
  readonly copy: MetricCopy
  /** The plot's height in pixels. The page's own toggle picks it, and hands
      the same number to the placeholder that stands in for this chart. */
  readonly height?: number
  /** The clock, injectable so tests can pin the frame. */
  readonly now?: () => number
}

// The frame advances once a second, whatever cadence the page polls the monitor
// at, and each host's newest reading is carried onto the new right edge with
// it. The collector reads each host far more slowly than that, so the tip of
// every line keeps moving between readings instead of freezing until the next
// one lands.
const FRAME_EVERY_MS = 1000

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

// Module-level so the default is one stable reference: an inline default would
// be a new function every render and reset the interval effect keyed on it each
// time.
const readClock = (): number => Date.now()

type ReadingTooltipProps = {
  readonly scale: ChartScale
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
  const rows: readonly ChartKeyRow[] =
    at === null
      ? []
      : plots.flatMap((plot) => {
          const value = plot.byTick.get(at)
          return value === undefined
            ? []
            : [
                {
                  key: plot.name,
                  value: scale.format(value),
                  name: plot.name,
                  swatchClass: seriesClass(plot.seriesIndex),
                },
              ]
        })
  // a break row carries no reading behind it, and an empty tooltip is noise
  if (active !== true || at === null || rows.length === 0) return null
  return <ChartTooltip title={stampExact(at)} rows={rows} mark="line" />
}

export const MetricChart = ({
  hosts,
  windowMinutes,
  unit,
  copy,
  height = COLLAPSED_CHART_HEIGHT,
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
  // Labelled at round minutes rather than wherever the domain divides, so the
  // ticks name round times and stay put while the frame slides under them. The
  // spacing widens with the range and narrows with the box.
  const dated = span > DAY_MS
  const axisMoments = labelledTicks({
    first,
    last: nowMs,
    width,
    labelPx: dated ? DAY_TIME_LABEL_PX : TIME_LABEL_PX,
    cap: tickCap(span),
  })

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
    <div className={chrome.chart}>
      <p className={chrome.caption}>{chartCaption({ copy, windowMinutes })}</p>

      {ageLabel !== null && <p className={styles.freshness}>Newest reading {ageLabel} ago.</p>}

      {ticks.length === 0 ? (
        <p className={chrome.empty}>
          No {copy.reading} readings in the last {rangeProse(windowMinutes)}. The chart fills in as
          the collector ticks.
        </p>
      ) : (
        <div className={`${chrome.plotWrap} ${chrome.plotWrapPadded}`} ref={ref}>
          <LineChart
            width={width}
            height={height}
            data={rows}
            margin={CHART_MARGIN}
            // Recharts' own keyboard layer: the chart takes a tab stop and the
            // arrow keys walk it, announcing each moment through the tooltip.
            accessibilityLayer
            role="img"
            aria-label={`${copy.title} by host over the last ${rangeProse(windowMinutes)}`}
          >
            <CartesianGrid className={chrome.grid} vertical={false} />
            <XAxis
              dataKey={AT_KEY}
              type="number"
              scale="time"
              // the frame is the window, not the extent of the data: a host that
              // stopped reporting an hour ago leaves empty space to the right
              // rather than stretching to fill it
              domain={[first, nowMs]}
              allowDataOverflow
              ticks={[...axisMoments]}
              tickFormatter={(at: number) => axisLabel({ at, dated })}
              // the label class rides the tick itself: Recharts hoists tick
              // text out of the axis group, where the axis class cannot
              // reach it
              tick={{ className: chrome.tickLabel }}
              tickLine={false}
              // every tick handed over is drawn: the axis already picked as
              // many as the box holds, and Recharts culling them again by its
              // own measure thinned a scale that was sized to fit
              interval={0}
              className={chrome.axis}
            />
            <YAxis
              type="number"
              domain={[0, scale.max]}
              ticks={[...scale.ticks]}
              tickFormatter={scale.format}
              width={scale.axisWidth}
              tick={{ className: chrome.tickLabel }}
              tickLine={false}
              axisLine={false}
              className={chrome.axis}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ className: chrome.crosshair }}
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

      <ChartLegend
        mark="line"
        items={visibleReadings.map((plot) => ({
          key: plot.name,
          name: plot.name,
          swatchClass: seriesClass(plot.seriesIndex),
          note: plot.points.length === 0 ? 'no readings' : undefined,
        }))}
      />
    </div>
  )
}
