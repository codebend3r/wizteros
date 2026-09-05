import { formatBytes, type MetricUnit } from '@/lib/fleetApi'

/** How one metric family's numbers become a y axis.
 *
 * The four charts share a component, so what differs between them has to be
 * data rather than branches inside the drawing code. A percent runs against a
 * fixed 0-100 whatever the readings do; a throughput has no natural ceiling at
 * all and takes one from the readings in view.
 */
export type MetricScale = {
  /** The top of the axis. */
  readonly max: number
  /** Where the gridlines sit, origin first. */
  readonly ticks: readonly number[]
  /** One value in words: the axis, the tooltip, the table and the screen
      reader readout all print through this, so they cannot disagree. */
  readonly format: (value: number) => string
  /** Room the axis labels need. "125.0 MB/s" does not fit where "100%" does,
      and a label wider than its margin is drawn over the plot. */
  readonly axisWidth: number
}

const TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const

// Ceilings worth landing on. 2.5 earns its place between 2 and 5: without it a
// 2.4 MB/s peak rounds all the way up to 5 and spends the chart's whole top
// half empty.
const NICE_STEPS = [1, 2, 2.5, 5, 10] as const

/** What one character of a label needs across at the axis's 12px font. Tabular
    digits and the letters of a unit both sit near 0.6em; this is a little over,
    so a measured width can only come in under the budget, never over it. */
const LABEL_CHAR_PX = 7.5

/** The margin Recharts keeps between tick and text, plus clear space between
    the label's end and the plot. */
const AXIS_PAD_PX = 12

/** Room for the widest label the axis will draw, so Recharts never wraps one
    onto a second line. It breaks a label at its space once the text outgrows
    the axis, and "100.0" over "MB/s" reads as two ticks where there is one. */
const axisWidthFor = ({
  ticks,
  format,
}: {
  ticks: readonly number[]
  format: (value: number) => string
}): number =>
  Math.ceil(Math.max(...ticks.map((tick) => format(tick).length)) * LABEL_CHAR_PX + AXIS_PAD_PX)

const formatPercent = (value: number): string => `${value}%`

/** Bytes per second in words. Zero is "0", not "0.0 B/s": an axis origin needs
    no unit, and the long form crowds the label off the plot. */
export const formatRate = (value: number): string => (value === 0 ? '0' : `${formatBytes(value)}/s`)

/** The 1024-based unit `formatBytes` will print a value of this size in.
 *
 * Never below 1: a value under a kilobyte is printed in bytes, and a negative
 * power here would scale the ceiling down instead of leaving it alone.
 */
const binaryUnit = (value: number): number => 1024 ** Math.max(0, Math.floor(Math.log2(value) / 10))

/** `value` rounded up to 1, 2, 2.5, 5 or 10 times its own decimal magnitude. */
const roundUpNicely = (value: number): number => {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = NICE_STEPS.find((candidate) => value <= candidate * magnitude) ?? 10
  return step * magnitude
}

/** A round ceiling at or above `peak`, so the axis lands on readable numbers
    rather than on whatever the busiest second happened to be.
 *
 * Rounded inside the binary unit the label will be printed in, not in plain
 * decimal. A decimal ceiling over a 1024-based formatter is what produced axes
 * reading "610.4 KB/s" and "1.2 MB/s": the numbers were round before
 * `formatBytes` divided them by 1024 and they stopped being round.
 *
 * A peak of zero or worse still yields 1: an axis from 0 to 0 has no height to
 * divide by, and every point would be drawn at a coordinate of NaN.
 */
export const niceCeiling = (peak: number): number => {
  if (!Number.isFinite(peak) || peak <= 0) return 1
  const unit = binaryUnit(peak)
  return roundUpNicely(peak / unit) * unit
}

export const metricScale = ({ unit, peak }: { unit: MetricUnit; peak: number }): MetricScale => {
  const percent = unit === 'percent'
  const max = percent ? 100 : niceCeiling(peak)
  const ticks = TICK_FRACTIONS.map((fraction) => max * fraction)
  const format = percent ? formatPercent : formatRate
  return { max, ticks, format, axisWidth: axisWidthFor({ ticks, format }) }
}
