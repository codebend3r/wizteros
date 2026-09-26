// Timestamps cross into SQLite as text, and the Python collector wrote every
// one of them with datetime.isoformat() on an aware UTC datetime:
// `2026-09-26T07:53:26.123456+00:00`, with the fraction left off entirely when
// it is zero. Range queries compare these strings, so a row written by Node has
// to sort among the Python rows exactly as the same instant would. That rules
// out Date#toISOString's `...Z` form, which sorts after `+00:00` for the same
// second.

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** `datetime.isoformat()` for a UTC instant, at the millisecond precision a Date carries. */
export const isoformat = (at: Date): string => {
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}`
  const time = `${pad(at.getUTCHours(), 2)}:${pad(at.getUTCMinutes(), 2)}:${pad(at.getUTCSeconds(), 2)}`
  const millis = at.getUTCMilliseconds()
  const fraction = millis === 0 ? '' : `.${pad(millis, 3)}000`
  return `${date}T${time}${fraction}+00:00`
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/

/**
 * `datetime.fromisoformat()` for the stored forms: microseconds are cut to the
 * millisecond a Date holds, and a missing offset is read as UTC, which is the
 * only zone either collector has ever written.
 */
export const parseIso = (text: string): Date => {
  const match = ISO.exec(text)
  if (!match) {
    throw new RangeError(`not an isoformat timestamp: ${text}`)
  }
  const [, year, month, day, hour, minute, second, fraction = '', offset = 'Z'] = match
  const millis = Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10)
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  )
  if (offset === 'Z') {
    return new Date(utc)
  }
  const sign = offset.startsWith('-') ? -1 : 1
  const [offsetHours, offsetMinutes] = offset.slice(1).split(':').map(Number)
  return new Date(utc - sign * ((offsetHours ?? 0) * 60 + (offsetMinutes ?? 0)) * 60_000)
}

/** Whole seconds since the epoch, like `int(at.timestamp())`. */
export const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000)

/** `at` moved by a number of seconds, which is what every timedelta here amounts to. */
export const addSeconds = ({ at, seconds }: { at: Date; seconds: number }): Date =>
  new Date(at.getTime() + seconds * 1000)

/** Seconds from `from` to `to`, as a float, like `(to - from).total_seconds()`. */
export const secondsBetween = ({ from, to }: { from: Date; to: Date }): number =>
  (to.getTime() - from.getTime()) / 1000

/**
 * How FastAPI put a datetime on the wire. Pydantic writes the same text as
 * isoformat() for a UTC instant, six fractional digits or none, but ends it
 * with `Z` rather than `+00:00`: `2026-09-26T07:00:00Z`,
 * `2026-09-26T07:00:01.123000Z`. Neither Date#toJSON (always three digits)
 * nor isoformat() matches it, and the portal was built against this form.
 */
export const pydanticTimestamp = (at: Date): string => `${isoformat(at).slice(0, -6)}Z`
