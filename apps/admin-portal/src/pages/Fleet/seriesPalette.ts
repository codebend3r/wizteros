import styles from '@/pages/Fleet/series.module.scss'

// Fixed assignment order, one slot per host position. Never cycled: a host
// past the last slot renders in the muted fallback rather than repeating a
// colour that already means another host. Both `/fleet` and `/fleet/cpu`
// list hosts in the same server-guaranteed order, so position is identity.
const SERIES_CLASSES = [
  styles.series1,
  styles.series2,
  styles.series3,
  styles.series4,
  styles.series5,
] as const

/** The class binding one host position to its colour, or '' past the palette. */
export const seriesClass = (index: number): string => SERIES_CLASSES[index] ?? ''
