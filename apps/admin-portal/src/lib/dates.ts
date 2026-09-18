export const DAY_MS = 24 * 60 * 60 * 1000

/** An ISO timestamp from the bridge as a Date, or null when absent or unparseable. */
export const parseTimestamp = (value: string | null): Date | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
