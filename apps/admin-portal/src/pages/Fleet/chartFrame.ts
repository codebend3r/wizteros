/** The plotted box's heights in pixels, collapsed and expanded.
 *
 * Recharts draws to an explicit pixel height rather than a CSS one, and the
 * placeholder shown while a chart loads has to reserve exactly that box or the
 * page jumps when the real one arrives. So the numbers live here, where the
 * chart and its placeholder both read them, instead of once in the component
 * and again in a stylesheet.
 */
export const COLLAPSED_CHART_HEIGHT = 240
export const EXPANDED_CHART_HEIGHT = 600

export const chartHeight = ({ expanded }: { expanded: boolean }): number =>
  expanded ? EXPANDED_CHART_HEIGHT : COLLAPSED_CHART_HEIGHT
