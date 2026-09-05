import type { IconName } from '@/components/Icon/Icon'
import type { MetricKind } from '@/lib/fleetApi'
import { rangeProse } from '@/stores/fleetPrefsStore'

/** The words one chart needs that the other three do not.
 *
 * Everything the four charts say in common lives in the component; this is
 * only what differs.
 */
export type MetricCopy = {
  /** The section heading. */
  readonly title: string
  /** The glyph over the title on its tab. */
  readonly icon: IconName
  /** What the numbers are, opening the description. */
  readonly measure: string
  /** The noun in "No ... readings in the last hour". */
  readonly reading: string
}

export const METRIC_COPY: Record<MetricKind, MetricCopy> = {
  cpu: {
    title: 'CPU',
    icon: 'cpu',
    measure: 'Aggregate CPU busy percent per host',
    reading: 'CPU',
  },
  memory: {
    title: 'Memory',
    icon: 'memory',
    measure: 'Used memory percent per host',
    reading: 'memory',
  },
  gpu: {
    title: 'GPU',
    icon: 'gpu',
    measure: 'Intel iGPU frequency as a share of its own ceiling, per host',
    reading: 'GPU',
  },
  network: {
    title: 'Network',
    icon: 'network',
    measure: 'Total throughput per host, received plus sent across every interface',
    reading: 'network',
  },
}

/** The sentence under a chart, describing what it draws and how to read it.
 *
 * Shared with the placeholder that stands in while a chart loads: the caption
 * is knowable before any reading is, so the placeholder can say the same thing
 * in the same space and the prose does not reflow when the lines arrive.
 */
export const chartCaption = ({
  copy,
  windowMinutes,
}: {
  copy: MetricCopy
  windowMinutes: number
}): string =>
  `${copy.measure} over the last ${rangeProse(windowMinutes)}. The line advances a point every second and holds the last reading between collector ticks, so a flat run means no new reading rather than steady load. A gap in a line is a span nothing was observed. Wide ranges arrive averaged into buckets, so a hole shorter than one bucket is averaged over rather than drawn as a gap.`
