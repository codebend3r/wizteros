import type { MetricKind } from '@/lib/fleetApi'

/** The words one chart needs that the other three do not.
 *
 * Everything the four charts say in common lives in the component; this is
 * only what differs. The caveats matter more than the titles: a GPU frequency
 * ratio drawn on a 0-100 axis looks exactly like a utilization percentage, and
 * nothing but the text below it says otherwise.
 */
export type MetricCopy = {
  /** The section heading. */
  readonly title: string
  /** What the numbers are, opening the description. */
  readonly measure: string
  /** The noun in "No ... readings in the last hour". */
  readonly reading: string
  /** A caveat this measure needs and the others do not. Empty for a measure
      that means exactly what it appears to mean. */
  readonly note: string
}

export const METRIC_COPY: Record<MetricKind, MetricCopy> = {
  cpu: {
    title: 'CPU',
    measure: 'Aggregate CPU busy percent per host',
    reading: 'CPU',
    note: '',
  },
  memory: {
    title: 'Memory',
    measure: 'Used memory percent per host',
    reading: 'memory',
    note: 'Measured against MemAvailable rather than MemFree, so reclaimable page cache is not counted as used. Read the other way these boxes report about 95% used while sitting idle.',
  },
  gpu: {
    title: 'GPU',
    measure: 'Intel iGPU frequency as a share of its own ceiling, per host',
    reading: 'GPU',
    note: 'A load proxy, not utilization. DSM ships no intel_gpu_top and does not expose the i915 perf interface, so a true busy percentage is not obtainable on this fleet: a card can sit at its floor frequency while working and at its ceiling while barely working. Only vermithor and vhagar have a render node, so the other three have no line here and never will.',
  },
  network: {
    title: 'Network',
    measure: 'Total throughput per host, received plus sent across every interface',
    reading: 'network',
    note: 'The only chart here without a fixed scale: its axis ceiling is taken from the busiest reading in view, so the same line height means a different rate at a different range.',
  },
}
