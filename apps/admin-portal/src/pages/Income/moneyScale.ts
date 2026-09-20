import { axisWidthFor, quarterTicks, type ChartScale } from '@/components/Chart/chartScale'
import { formatMoney } from '@/lib/income'

/** A round ceiling a little above a peak, so the top gridline is a clean
    figure and the line never touches the frame. Zero data still gets a scale.
    Always a multiple of four, so the quarter ticks are whole dollars. */
export const niceCeiling = (peak: number): number => {
  if (peak <= 0) return 100
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const unit = Math.max(4, magnitude >= 100 ? magnitude / 5 : magnitude)
  return Math.ceil((peak * 1.1) / unit) * unit
}

/** A figure that carries its own direction, for an axis drawn either side of a
    baseline: zero keeps its plain form, since nothing moved in either way. */
export const signed = (value: number): string =>
  value === 0 ? formatMoney(0) : `${value > 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`

/** A money y axis, from one object so a chart's domain, gridlines, labels and
 * axis width cannot drift apart.
 *
 * `mirrored` is the movements chart, which draws losses below a baseline: the
 * scale then runs from `-ceiling` to `ceiling` and every figure on it says
 * which way it went.
 */
export const moneyScale = ({
  peak,
  mirrored = false,
  axisWidth,
}: {
  peak: number
  mirrored?: boolean
  /** The room this chart's axis is given. Set by hand rather than measured:
      both income charts sit at a known width, and a measured budget would only
      restate the number they already agree on. */
  axisWidth?: number
}): ChartScale => {
  const ceiling = niceCeiling(peak)
  const ticks = quarterTicks({ ceiling, mirrored })
  const format = mirrored ? signed : formatMoney
  return {
    min: mirrored ? -ceiling : 0,
    max: ceiling,
    ticks,
    format,
    axisWidth: axisWidth ?? axisWidthFor({ ticks, format }),
  }
}
