export type SampleKind = 'gauge' | 'counter'

/**
 * One measurement. Deliberately carries no timestamp: probes are pure and
 * never read the clock, so the collector stamps samples on arrival.
 */
export type Sample = Readonly<{
  metric: string
  value: number
  kind: SampleKind
}>
