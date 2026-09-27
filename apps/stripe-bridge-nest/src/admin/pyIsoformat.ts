// `datetime.fromisoformat(text).isoformat()` as Python 3.12 answers it, for
// the admin's absolute expiry. The text is echoed back into Wizarr, the event
// log and the response, so it has to come out exactly as the Python bridge
// wrote it: a naive input stays naive, an offset is kept as given rather than
// converted to UTC, and microseconds are printed as six digits only when they
// are nonzero. A JavaScript Date could do none of that, so the fields are
// parsed and rendered by hand.
//
// Accepted, as 3.12 accepts them: an extended (2026-08-01) or basic
// (20260801) date, optionally followed by any one separator character and a
// time of HH, HH:MM, HH:MM:SS or their basic forms, with a fraction of any
// length after `.` or `,` (cut to microseconds), and an offset of the same
// shape after `+` or `-`. Not accepted, unlike 3.12: ISO week dates
// (2026-W31-1), which nothing sends.

type Clock = Readonly<{ hour: number; minute: number; second: number; micro: number }>

const DATE_EXTENDED = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_BASIC = /^(\d{4})(\d{2})(\d{2})$/
const CLOCK_EXTENDED = /^(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?$/
const CLOCK_BASIC = /^(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?$/

const DAY_SECONDS = 86_400

const pad = ({ value, width }: { value: number; width: number }): string =>
  String(value).padStart(width, '0')

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysIn = ({ year, month }: { year: number; month: number }): number =>
  [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0

/** The date part as year, month and day; null when malformed or out of range. */
const parseDate = (text: string): Readonly<{ year: number; month: number; day: number }> | null => {
  const match = DATE_EXTENDED.exec(text) ?? DATE_BASIC.exec(text)
  if (match === null) {
    return null
  }
  const [year, month, day] = [match[1], match[2], match[3]].map(Number)
  if (year === undefined || month === undefined || day === undefined) {
    return null
  }
  const valid = year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn({ year, month })
  return valid ? { year, month, day } : null
}

/**
 * HH[:MM[:SS[.ffffff]]] or its basic form, unchecked for range. Which form is
 * decided by the character after the hour, as Python decides it, so a mix of
 * the two is refused.
 */
const parseClock = (text: string): Clock | null => {
  const match = (text[2] === ':' ? CLOCK_EXTENDED : CLOCK_BASIC).exec(text)
  if (match === null) {
    return null
  }
  const fraction = match[4] ?? ''
  return {
    hour: Number(match[1]),
    minute: Number(match[2] ?? 0),
    second: Number(match[3] ?? 0),
    micro: Number(fraction.padEnd(6, '0').slice(0, 6)),
  }
}

/**
 * The offset as `timezone(...)` prints it inside isoformat(). Its fields are
 * not range-checked, only its total (strictly under a day), so +05:75 reads as
 * +06:15. A zero offset in whole seconds is the UTC singleton, whose
 * microseconds 3.12 drops, and -00:00 is +00:00.
 */
const renderOffset = ({ sign, clock }: { sign: string; clock: Clock }): string | null => {
  const seconds = clock.hour * 3600 + clock.minute * 60 + clock.second
  if (seconds + clock.micro / 1_000_000 >= DAY_SECONDS) {
    return null
  }
  if (seconds === 0) {
    return '+00:00'
  }
  const hh = pad({ value: Math.floor(seconds / 3600), width: 2 })
  const mm = pad({ value: Math.floor((seconds % 3600) / 60), width: 2 })
  const ss = seconds % 60
  const tail =
    ss === 0 && clock.micro === 0
      ? ''
      : `:${pad({ value: ss, width: 2 })}${clock.micro === 0 ? '' : `.${pad({ value: clock.micro, width: 6 })}`}`
  return `${sign === '-' ? '-' : '+'}${hh}:${mm}${tail}`
}

/** The time part (clock plus optional offset), rendered; null when invalid. */
const renderTime = (text: string): string | null => {
  const at = text.search(/[+-]/)
  const clock = parseClock(at === -1 ? text : text.slice(0, at))
  if (clock === null) {
    return null
  }
  const inRange = clock.hour <= 23 && clock.minute <= 59 && clock.second <= 59
  if (!inRange) {
    return null
  }
  const offsetClock = at === -1 ? null : parseClock(text.slice(at + 1))
  if (at !== -1 && offsetClock === null) {
    return null
  }
  const offset =
    offsetClock === null ? '' : renderOffset({ sign: text.charAt(at), clock: offsetClock })
  if (offset === null) {
    return null
  }
  const hhmmss = [clock.hour, clock.minute, clock.second]
    .map((value) => pad({ value, width: 2 }))
    .join(':')
  const micro = clock.micro === 0 ? '' : `.${pad({ value: clock.micro, width: 6 })}`
  return `${hhmmss}${micro}${offset}`
}

/**
 * Python 3.12's `datetime.fromisoformat(text).isoformat()`, or null where
 * fromisoformat would raise ValueError.
 */
export const pyIsoformat = (text: string): string | null => {
  // Python tells the two date forms apart by a dash after the year.
  const dateLength = text[4] === '-' ? 10 : 8
  const date = parseDate(text.slice(0, dateLength))
  if (date === null) {
    return null
  }
  // Any one character may separate the date from the time.
  const time = text.length > dateLength ? renderTime(text.slice(dateLength + 1)) : '00:00:00'
  if (time === null) {
    return null
  }
  const day = `${pad({ value: date.year, width: 4 })}-${pad({ value: date.month, width: 2 })}-${pad({ value: date.day, width: 2 })}`
  return `${day}T${time}`
}
