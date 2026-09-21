/** The margin Recharts keeps outside the plot: room at the top for the tallest
 * mark's cap, room at the right for the last tick's label to sit under its
 * own tick rather than run off the box.
 *
 * Left is zero because the y axis reserves its own width from the scale, and a
 * margin on top of that would be a second, invisible gutter.
 */
export const CHART_MARGIN = { top: 12, right: 16, bottom: 4, left: 0 } as const

/** The plotted box's heights in pixels, collapsed and expanded.
 *
 * Recharts draws to an explicit pixel height rather than a CSS one, and the
 * placeholder shown while a chart loads has to reserve exactly that box or the
 * page jumps when the real one arrives. So the numbers live here, where every
 * chart and every placeholder reads them, instead of once in a component and
 * again in a stylesheet.
 */
export const COLLAPSED_CHART_HEIGHT = 240
export const EXPANDED_CHART_HEIGHT = 600

export const chartHeight = ({ expanded }: { expanded: boolean }): number =>
  expanded ? EXPANDED_CHART_HEIGHT : COLLAPSED_CHART_HEIGHT
