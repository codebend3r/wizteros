/** The plotted box's height in pixels.
 *
 * Recharts draws to an explicit pixel height rather than a CSS one, and the
 * placeholder shown while a chart loads has to reserve exactly that box or the
 * page jumps when the real one arrives. So the number lives here, where the
 * chart and its placeholder both read it, instead of once in the component and
 * again in a stylesheet.
 */
export const CHART_HEIGHT = 230
