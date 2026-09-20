/** How one chart's numbers become a y axis.
 *
 * Charts that share a component need what differs between them to be data
 * rather than branches inside the drawing code, and charts that do not share
 * one still have to agree on what an axis is: a domain, the gridlines in it,
 * one formatter every readout prints through, and the room the labels need.
 */
export type ChartScale = {
  /** The bottom of the axis: zero, or the mirror of `max` on a chart that
      draws losses below a baseline. */
  readonly min: number
  /** The top of the axis. */
  readonly max: number
  /** Where the gridlines sit, lowest first. */
  readonly ticks: readonly number[]
  /** One value in words: the axis, the tooltip, the table and the screen
      reader readout all print through this, so they cannot disagree. */
  readonly format: (value: number) => string
  /** Room the axis labels need. "125.0 MB/s" does not fit where "100%" does,
      and a label wider than its margin is drawn over the plot. */
  readonly axisWidth: number
}

const TICK_SHARES = [0, 0.25, 0.5, 0.75, 1] as const
const MIRRORED_TICK_SHARES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1] as const

/** Evenly spaced ticks from zero (or `-ceiling`) to `ceiling`, in quarters.
    Recharts' own picks land on figures like 95 and 175; these stay round. */
export const quarterTicks = ({
  ceiling,
  mirrored = false,
}: {
  ceiling: number
  mirrored?: boolean
}): readonly number[] =>
  (mirrored ? MIRRORED_TICK_SHARES : TICK_SHARES).map((share) => ceiling * share)

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
export const axisWidthFor = ({
  ticks,
  format,
}: {
  ticks: readonly number[]
  format: (value: number) => string
}): number =>
  Math.ceil(Math.max(...ticks.map((tick) => format(tick).length)) * LABEL_CHAR_PX + AXIS_PAD_PX)
