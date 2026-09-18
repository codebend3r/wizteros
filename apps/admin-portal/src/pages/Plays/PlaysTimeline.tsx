import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { windowProse, type HostCount, type Timeline } from '@/lib/playsApi'
import { useMeasuredWidth } from '@/lib/useMeasuredWidth'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { bucketLabel, formatCount } from '@/pages/Plays/playsFormat'
import styles from '@/pages/Plays/PlaysTimeline.module.scss'

/** The plot's height in pixels. Recharts draws to a pixel height, and the
    overview's own layout reserves this box, so it lives here rather than in
    a stylesheet. */
export const TIMELINE_HEIGHT = 240

type PlaysTimelineProps = {
  readonly timeline: Timeline
  /** Every Plex host in the monitor's config order, which is what binds each
      to its colour: position is identity, on this chart and on the fleet page. */
  readonly hosts: readonly HostCount[]
  readonly days: number
}

/** One row of the dataset Recharts draws: a bucket, and every host's plays in
    it. Host columns are prefixed so a host named "start" could not collide
    with the bucket column. */
type TimelineRow = Record<string, string | number>

const START_KEY = 'start'

const hostKey = (host: string): string => `host:${host}`

const MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const

const toRows = ({
  timeline,
  hosts,
}: {
  timeline: Timeline
  hosts: readonly HostCount[]
}): TimelineRow[] =>
  timeline.points.map((point) =>
    Object.fromEntries([
      [START_KEY, point.start],
      ...hosts.map((host): [string, number] => [hostKey(host.host), point.hosts[host.host] ?? 0]),
    ]),
  )

type TimelineTooltipProps = {
  readonly timeline: Timeline
  readonly hosts: readonly HostCount[]
  /** Injected by Recharts when it clones this element, which is why they are
      optional here and nowhere else. */
  readonly active?: boolean
  readonly label?: unknown
}

/** Every server's plays in the inspected bucket, and the total.
 *
 * Written rather than taking Recharts' default so the swatch stays the same
 * one the legend and the breakdown list use, and so a host with no plays in
 * the bucket is left out rather than listed at zero.
 */
const TimelineTooltip = ({ timeline, hosts, active, label }: TimelineTooltipProps) => {
  const point =
    typeof label === 'string'
      ? timeline.points.find((candidate) => candidate.start === label)
      : undefined
  if (active !== true || point === undefined) return null
  const rows = hosts.flatMap((host, index) => {
    const plays = point.hosts[host.host] ?? 0
    return plays > 0 ? [{ host: host.host, index, plays }] : []
  })
  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>
        {bucketLabel({ start: point.start, bucket: timeline.bucket })}
      </p>
      <ul className={styles.tooltipRows}>
        {rows.map((row) => (
          <li key={row.host} className={styles.tooltipRow}>
            <span className={`${styles.swatch} ${seriesClass(row.index)}`} aria-hidden="true" />
            <span className={styles.tooltipValue}>{formatCount(row.plays)}</span>
            <span className={styles.tooltipName}>{row.host}</span>
          </li>
        ))}
        <li className={styles.tooltipRow}>
          <span className={styles.swatchGap} aria-hidden="true" />
          <span className={styles.tooltipValue}>{formatCount(point.plays)}</span>
          <span className={styles.tooltipName}>plays</span>
        </li>
      </ul>
    </div>
  )
}

/** Completed plays per bucket, stacked by server.
 *
 * Stacked rather than grouped because the question the page asks first is
 * "how much was watched", and the split by server is the second reading of
 * the same bar. The monitor picks the bucket from the window, so a week is
 * seven bars a day wide and a year twelve a month wide, on one axis.
 */
export const PlaysTimeline = ({ timeline, hosts, days }: PlaysTimelineProps) => {
  const { ref, width } = useMeasuredWidth()
  const rows = toRows({ timeline, hosts })
  const caption = `Completed plays per ${timeline.bucket}, stacked by server, ${windowProse(days)}.`

  if (timeline.points.length === 0) {
    return (
      <div className={styles.chart}>
        <p className={styles.caption}>{caption}</p>
        <p className={styles.empty}>No completed plays {windowProse(days)}.</p>
      </div>
    )
  }

  return (
    <div className={styles.chart}>
      <p className={styles.caption}>{caption}</p>
      <div className={styles.plotWrap} ref={ref}>
        <BarChart
          width={width}
          height={TIMELINE_HEIGHT}
          data={rows}
          margin={MARGIN}
          barCategoryGap="25%"
          maxBarSize={40}
          // Recharts' own keyboard layer: the chart takes a tab stop and the
          // arrow keys walk it, announcing each bucket through the tooltip.
          accessibilityLayer
          role="img"
          aria-label={`Completed plays per ${timeline.bucket} by server ${windowProse(days)}`}
        >
          <CartesianGrid className={styles.grid} vertical={false} />
          <XAxis
            dataKey={START_KEY}
            tickFormatter={(value: string) =>
              bucketLabel({ start: value, bucket: timeline.bucket })
            }
            tick={{ className: styles.tickLabel }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
            className={styles.axis}
          />
          <YAxis
            type="number"
            allowDecimals={false}
            tickFormatter={(value: number) => formatCount(value)}
            tick={{ className: styles.tickLabel }}
            tickLine={false}
            axisLine={false}
            width={44}
            className={styles.axis}
          />
          <Tooltip
            isAnimationActive={false}
            cursor={{ className: styles.hoverBand }}
            content={<TimelineTooltip timeline={timeline} hosts={hosts} />}
          />
          {hosts.map((host, index) => (
            <Bar
              key={host.host}
              dataKey={hostKey(host.host)}
              name={host.host}
              stackId="plays"
              // the class carries --series-color, which the fill reads: one
              // colour per host position, the same one its fleet card wears
              className={seriesClass(index)}
              fill="var(--series-color, currentColor)"
              // the surface-coloured stroke is the 2px gap between segments
              stroke="var(--color-surface)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </div>
      <ul className={styles.legend}>
        {hosts.map((host, index) => (
          <li key={host.host} className={styles.legendItem}>
            <span className={`${styles.swatch} ${seriesClass(index)}`} aria-hidden="true" />
            <span>{host.host}</span>
            {host.plays === 0 && <span className={styles.legendNote}>no plays</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
