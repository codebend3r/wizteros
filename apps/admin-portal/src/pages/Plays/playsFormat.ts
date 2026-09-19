import { formatAge } from '@/lib/fleetApi'
import type { TimelineBucket } from '@/lib/playsApi'

/** A count with thousands separators, the way every figure on the page reads. */
export const formatCount = (value: number): string => value.toLocaleString()

/** Summed play durations as whole hours: "1,234 h". Whole, because the ledger
    counts completions, and minutes would claim a precision it does not have. */
export const formatHours = (watchMs: number): string =>
  `${Math.round(watchMs / 3_600_000).toLocaleString()} h`

const parse = (iso: string | null): Date | null => {
  if (iso === null) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

/** A moment with its time, or "never" for an absent one. */
export const formatDateTime = (iso: string | null): string => {
  const at = parse(iso)
  return at === null ? 'never' : at.toLocaleString()
}

/** A moment as a date only, for columns where the time is noise. */
export const formatDate = (iso: string | null): string => {
  const at = parse(iso)
  return at === null ? 'never' : at.toLocaleDateString()
}

/** How long ago a stamp was, in the monitor's own words ("3 minutes"). */
export const formatAgeSince = ({ iso, now }: { iso: string | null; now: number }): string => {
  const at = parse(iso)
  return at === null ? 'unknown' : formatAge(Math.max(0, Math.floor((now - at.getTime()) / 1000)))
}

/** "Sep 2025", for the sentence that says how far back the ledger reaches. */
export const monthYear = (iso: string | null): string => {
  const at = parse(iso)
  return at === null ? 'unknown' : at.toLocaleDateString([], { month: 'short', year: 'numeric' })
}

/** "S4 E1" from an episode's season and index; empty when neither is known. */
export const episodeLabel = ({
  parentIndex,
  index,
}: {
  parentIndex: number | null
  index: number | null
}): string =>
  [parentIndex === null ? '' : `S${parentIndex}`, index === null ? '' : `E${index}`]
    .filter((part) => part.length > 0)
    .join(' ')

/** The monitor's quality as a reader sees it. `sd` is spelled out; an unknown
    bucket is "Other" because that is where the filter puts it; an absent one
    is a dash, since audio has no resolution and a play whose item is gone
    cannot be dated to one. */
export const qualityLabel = (quality: string | null): string => {
  if (quality === null) return '--'
  if (quality === '4k') return '4K'
  if (quality === 'sd') return 'SD'
  if (quality === '1080p' || quality === '720p') return quality
  return 'Other'
}

const DAY_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' }
const MONTH_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
}

/** A bucket's label on the timeline axis: the day it starts, or the month.
    Read as UTC on purpose: the start is a bare date, and reading it in local
    time would print the previous day west of Greenwich. */
export const bucketLabel = ({
  start,
  bucket,
}: {
  start: string
  bucket: TimelineBucket
}): string => {
  const at = new Date(`${start}T00:00:00Z`)
  if (Number.isNaN(at.getTime())) return start
  return at.toLocaleDateString([], bucket === 'month' ? MONTH_OPTIONS : DAY_OPTIONS)
}

export const titleWithYear = ({ title, year }: { title: string; year: number | null }): string =>
  year === null ? title : `${title} (${year})`

export const listHosts = (hosts: readonly string[]): string =>
  hosts.length === 0 ? '--' : hosts.join(', ')
