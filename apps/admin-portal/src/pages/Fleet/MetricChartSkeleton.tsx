import { COLLAPSED_CHART_HEIGHT } from '@/pages/Fleet/chartFrame'
import { chartCaption, type MetricCopy } from '@/pages/Fleet/metricCopy'
import styles from '@/pages/Fleet/MetricChartSkeleton.module.scss'
import { rangeProse } from '@/stores/fleetPrefsStore'

type MetricChartSkeletonProps = {
  readonly copy: MetricCopy
  readonly windowMinutes: number
  /** The hosts the fleet is known to have, so the legend row below the plot
      reserves the height it will actually take. Empty until the fleet query
      answers, which is the one case the row can still reflow. */
  readonly hostNames: readonly string[]
  /** The height the chart it stands in for will be drawn at. */
  readonly height?: number
}

/** The chart's own shape, held while its readings load.
 *
 * A chart that unmounts between tabs takes about three hundred pixels of page
 * with it, so everything below jumps up and back down a moment later - on every
 * tab press and every range press. This stands in the same box: the same
 * caption, a plot area at exactly the chart's height, and the same legend row.
 * Nothing here states a reading, which is the line it must not cross - a
 * placeholder that drew plausible lines would be a monitor inventing data.
 */
export const MetricChartSkeleton = ({
  copy,
  windowMinutes,
  hostNames,
  height = COLLAPSED_CHART_HEIGHT,
}: MetricChartSkeletonProps) => (
  <div className={styles.chart}>
    <p className={styles.subtitle}>{chartCaption({ copy, windowMinutes })}</p>

    <div className={styles.plotWrap}>
      {/* the height is the chart's own number, in pixels, because the chart is
        drawn at a pixel height: a stylesheet copy would be a second place for
        it to drift */}
      <div className={styles.plot} style={{ height: `${height}px` }}>
        <p className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Loading {copy.reading} readings for the last {rangeProse(windowMinutes)}.
        </p>
      </div>
    </div>

    {/* The hosts, with no colour claimed for them yet: the series a host wears
      is assigned by the answer that has not arrived. */}
    <ul className={styles.legend}>
      {hostNames.map((name) => (
        <li key={name} className={styles.legendItem}>
          <span className={styles.seriesKey} aria-hidden="true" />
          <span>{name}</span>
        </li>
      ))}
    </ul>
  </div>
)
