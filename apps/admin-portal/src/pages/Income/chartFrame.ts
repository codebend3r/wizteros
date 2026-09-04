/** The plotted box's height in pixels. Recharts draws to an explicit pixel
    height rather than a CSS one, so both charts read it from here. */
export const CHART_HEIGHT = 230

/** A round ceiling a little above a peak, so the top gridline is a clean
    figure and the line never touches the frame. Zero data still gets a scale.
    Always a multiple of four, so the quarter ticks below are whole dollars. */
export const niceCeiling = (peak: number): number => {
  if (peak <= 0) return 100
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const unit = Math.max(4, magnitude >= 100 ? magnitude / 5 : magnitude)
  return Math.ceil((peak * 1.1) / unit) * unit
}

/** Evenly spaced ticks from `-ceiling` (or zero) to `ceiling`, in quarters.
    Recharts' own picks land on figures like 95 and 175; these stay round. */
export const quarterTicks = ({
  ceiling,
  mirrored = false,
}: {
  ceiling: number
  mirrored?: boolean
}): readonly number[] => {
  const shares = mirrored
    ? [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
    : [0, 0.25, 0.5, 0.75, 1]
  return shares.map((share) => ceiling * share)
}
