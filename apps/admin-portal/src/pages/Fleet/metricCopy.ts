import type { MetricKind } from '@/lib/fleetApi'

/** The words one chart needs that the other three do not.
 *
 * Everything the four charts say in common lives in the component; this is
 * only what differs.
 */
export type MetricCopy = {
  /** The section heading. */
  readonly title: string
  /** What the numbers are, opening the description. */
  readonly measure: string
  /** The noun in "No ... readings in the last hour". */
  readonly reading: string
}

export const METRIC_COPY: Record<MetricKind, MetricCopy> = {
  cpu: {
    title: 'CPU',
    measure: 'Aggregate CPU busy percent per host',
    reading: 'CPU',
  },
  memory: {
    title: 'Memory',
    measure: 'Used memory percent per host',
    reading: 'memory',
  },
  gpu: {
    title: 'GPU',
    measure: 'Intel iGPU frequency as a share of its own ceiling, per host',
    reading: 'GPU',
  },
  network: {
    title: 'Network',
    measure: 'Total throughput per host, received plus sent across every interface',
    reading: 'network',
  },
}
