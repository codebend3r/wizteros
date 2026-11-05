/** The margin Recharts keeps outside the plot: room at the top for the tallest
 * mark's cap, room at the right for the last tick's label to sit under its
 * own tick rather than run off the box.
 *
 * Left is zero because the y axis reserves its own width from the scale, and a
 * margin on top of that would be a second, invisible gutter.
 */
export const CHART_MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const

/** The plotted box's height in pixels, for a chart drawn at a fixed height.
 *
 * Recharts draws to an explicit pixel height rather than a CSS one, so a chart
 * whose box is not sized by its stylesheet takes this number. It is also what
 * a measured box reports before its first measurement.
 */
export const COLLAPSED_CHART_HEIGHT = 240
