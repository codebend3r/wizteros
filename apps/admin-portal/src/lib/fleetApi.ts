import {
  type FleetContainer,
  type FleetHost,
  type FleetResponse,
  fleetResponseSchema,
  guardOf,
  type HostStatus,
  type Incident,
  type IncidentFeed,
  incidentFeedSchema,
  type MetricHistory,
  metricHistorySchema,
  type MetricHostSeries,
  type MetricKind,
  type MetricPoint,
  type MetricUnit,
} from '@wizteros/wire'
import { createClient } from '@/lib/http'

// The response types are the wire contract's, in libs/wire, where the monitor's
// own route tests check every body against the same schemas this module reads
// them with.
export type {
  FleetContainer,
  FleetHost,
  FleetResponse,
  HostStatus,
  Incident,
  IncidentFeed,
  MetricHistory,
  MetricHostSeries,
  MetricKind,
  MetricPoint,
  MetricUnit,
}

const isFleetResponse = guardOf(fleetResponseSchema)
const isMetricHistory = guardOf(metricHistorySchema)
const isIncidentFeed = guardOf(incidentFeedSchema)

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

const AGE_UNITS = [
  { seconds: 86_400, name: 'day' },
  { seconds: 3600, name: 'hour' },
  { seconds: 60, name: 'minute' },
] as const

export const formatBytes = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '--'
  // log2/10, not log(v)/log(1024): the latter comes back 2.9999999999999996 for
  // exactly 1024 ** 3, which floors to the wrong unit and renders "1024.0 MB"
  const index = Math.min(
    UNITS.length - 1,
    Math.max(0, Math.floor(Math.log2(Math.max(value, 1)) / 10)),
  )
  return `${(value / 1024 ** index).toFixed(1)} ${UNITS[index]}`
}

export const plural = ({ count, unit }: { count: number; unit: string }): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`

/** A metric age in words. "unknown" for an absent age, because a host that was
    never measured has no age at all, and rendering it as 0 would read as fresh. */
export const formatAge = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'unknown'
  const unit = AGE_UNITS.find((candidate) => seconds >= candidate.seconds)
  return unit
    ? plural({ count: Math.floor(seconds / unit.seconds), unit: unit.name })
    : 'less than a minute'
}

/** The fleet monitor, which serves the play history too: every read on this
    page and the play-history pages goes through it. */
export const monitor = createClient({
  base: import.meta.env.VITE_FLEET_BASE ?? '',
  baseVariable: 'VITE_FLEET_BASE',
  name: 'the fleet monitor',
})

export const fetchFleet = (): Promise<FleetResponse> =>
  monitor.read({ path: '/fleet', is: isFleetResponse, what: 'fleet response' })

/** One metric family's history. The kind is the route, so a new chart is a new
    kind on both sides rather than a second fetcher here. */
/** The monitor's own ceiling on a history window, a week: raw samples are
    pruned past it, so it refuses anything wider. Mirrored here so the lead-in
    below cannot push a week-wide request over the edge into a refusal. */
export const MAX_HISTORY_MINUTES = 10_080

/** How much history to ask for beyond the frame a chart draws.
 *
 * The frame is [now - window, now], and the first reading inside it can sit a
 * whole collector tick past the left edge, so a line that began there left a
 * strip of empty plot before it. One minute covers two ticks plus clock skew
 * between the monitor and the browser: the reading before the edge arrives
 * with the rest, and the line is drawn in from it.
 */
export const HISTORY_LEAD_IN_MINUTES = 1

export const historyMinutes = (windowMinutes: number): number =>
  Math.min(windowMinutes + HISTORY_LEAD_IN_MINUTES, MAX_HISTORY_MINUTES)

export const fetchMetricHistory = async ({
  kind,
  minutes,
}: {
  kind: MetricKind
  minutes: number
}): Promise<MetricHistory> => {
  const data = await monitor.read({
    path: `/fleet/${kind}?minutes=${minutes}`,
    is: isMetricHistory,
    what: `${kind} history response`,
  })
  // A response that answered for a different family would paint one chart with
  // another's numbers, silently and plausibly.
  if (data.kind !== kind) {
    throw new Error(`Asked the fleet monitor for ${kind} history and got ${data.kind}`)
  }
  return data
}

export const fetchIncidents = ({ hours }: { hours: number }): Promise<IncidentFeed> =>
  monitor.read({
    path: `/incidents?hours=${hours}`,
    is: isIncidentFeed,
    what: 'incidents response',
  })
