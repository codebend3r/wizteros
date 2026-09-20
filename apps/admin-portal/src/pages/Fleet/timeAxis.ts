const timeShort = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const dayTimeShort = (at: number): string =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

/** The inspected moment, to the second and carrying its date.
 *
 * Every range past a day holds each wall-clock time several times over, so a
 * time alone names a moment the reader cannot place: 07:51 PM on which of the
 * seven days a week-wide frame is showing?
 */
export const stampExact = (at: number): string =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
const WIDEST_TICK_STEP_MS = 7 * DAY_MS

/** The spacings the x axis may label at, narrowest first.
 *
 * Every one divides an hour or a day evenly, which is what keeps a tick on a
 * round minute rather than on whatever second the frame happened to start
 * at. Recharts' own tick picker divides the domain instead, so it labels the
 * moving present's offset - 07:23, 07:38 - and the labels shuffle every second
 * as the frame slides.
 *
 * No neighbour is more than 2.5 times the last. The picker takes the narrowest
 * spacing that keeps the axis under its cap, so that ratio is what keeps it
 * from dropping under half of the cap when it widens by one: every preset
 * range past a quarter hour lands between six and twelve labels on a box wide
 * enough to hold them, and the quarter hour itself labels every minute.
 */
const TICK_STEPS_MS = [
  MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  10 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  WIDEST_TICK_STEP_MS,
] as const

/** The most labels the axis carries: past this they read as a band of text
    rather than as marks along a scale. */
const MAX_TICKS = 12

/** A quarter hour is the one range short enough to label every minute, and
    fifteen marks a minute apart still read as a scale: the reader counts
    minutes off it directly. */
const MINUTE_BY_MINUTE_MS = 15 * MINUTE_MS
const MINUTE_BY_MINUTE_TICKS = 15

export const tickCap = (span: number): number =>
  span <= MINUTE_BY_MINUTE_MS ? MINUTE_BY_MINUTE_TICKS : MAX_TICKS

/** What one label needs across, its text plus the space that keeps two labels
    from touching. "08:56 PM" runs near 58px at the axis font, so 64 leaves a
    sliver between neighbours and lets fifteen minute marks fit a 960px box. A
    dated label is near twice the text of a time. */
export const TIME_LABEL_PX = 64
export const DAY_TIME_LABEL_PX = 116

/** Every boundary of the chosen spacing that falls inside the frame.
 *
 * Aligned against local midnight rather than the epoch, which is UTC midnight:
 * in a zone offset by a half hour the epoch's hours land on :30, and the axis
 * would promise quarter hours while labelling :07 and :22. Stepping on from
 * the first aligned tick keeps the rest aligned through a daylight-saving
 * shift too, because every zone shifts by a whole number of quarter hours.
 */
const axisTicks = ({
  first,
  last,
  step,
}: {
  first: number
  last: number
  step: number
}): readonly number[] => {
  const offset = new Date(first).getTimezoneOffset() * 60_000
  const start = Math.ceil((first - offset) / step) * step + offset
  const count = Math.max(0, Math.floor((last - start) / step) + 1)
  return Array.from({ length: count }, (_, index) => start + index * step)
}

/** The ticks of the narrowest spacing that fits: at most `cap`, and no more
 * than the measured box can hold without two labels touching, so a phone
 * drops to hourly ticks where a desktop carries five minutes.
 *
 * Counted by laying the ticks out, not by dividing the span: a frame whose
 * edge lands exactly on a boundary carries one tick more than the division
 * says, and the cap is a promise about what is drawn.
 */
export const labelledTicks = ({
  first,
  last,
  width,
  labelPx,
  cap,
}: {
  first: number
  last: number
  width: number
  labelPx: number
  cap: number
}): readonly number[] => {
  const budget = Math.min(cap, Math.max(2, Math.floor(width / labelPx)))
  const candidates = TICK_STEPS_MS.map((step) => axisTicks({ first, last, step }))
  return (
    candidates.find((ticks) => ticks.length <= budget) ?? candidates[candidates.length - 1] ?? []
  )
}

/** A tick's label: date and time once the frame spans more than a day, where a
    time alone could name any of several days it is drawn on; time alone below
    that, since the frame never crosses a day boundary more than once. */
export const axisLabel = ({ at, dated }: { at: number; dated: boolean }): string =>
  dated ? dayTimeShort(at) : timeShort(at)
