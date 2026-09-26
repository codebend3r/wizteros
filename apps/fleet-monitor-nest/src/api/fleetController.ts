import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SupabaseAdminGuard } from '@wizteros/server-common'
import { z } from 'zod'
import { intQuery } from '@/api/validation.js'
import { dbPath } from '@/config.js'
import { session } from '@/db.js'
import { ageSeconds, type FleetView, fleetView, STALE_AFTER_SECONDS } from '@/fleet.js'
import { history, type Incident, openIncidents } from '@/incidents.js'
import { fleetHistory, type Kind, type MetricHistoryView } from '@/series.js'
import { lastHeartbeat } from '@/store.js'
import { addSeconds } from '@/time.js'

// Liveness, the fleet, its charts and its incidents. Every route opens one
// session for its whole response, and in `read` mode: the API never writes the
// main database, so a request must never make the collector wait for the
// write lock.

// Generous but bounded, well under what a Date can represent. Without a cap
// an absurd `hours` value overflowed the C int Python's `timedelta` builds
// from and turned into an unhandled 500 instead of a client error.
export const MAX_INCIDENT_HOURS = 24 * 365 * 5

// The history window every chart shares. The floor is one vitals tick past
// nothing (a counter-derived series yields no delta from a single reading, so
// anything shorter cannot answer); the ceiling is seven days, which is how
// long raw samples live before rollups.prune takes them, so asking for more
// could only ever answer with less. Windows past a few hours carry more ticks
// than a chart can draw, so the series is bucketed on the way out rather than
// the window being refused.
export const DEFAULT_HISTORY_MINUTES = 60
export const MAX_HISTORY_MINUTES = 7 * 24 * 60

const DEFAULT_INCIDENT_HOURS = 24

export type HealthView = Readonly<{
  ok: boolean
  heartbeat_age_seconds: number | null
  stale: boolean
}>

export type IncidentFeed = Readonly<{
  open: readonly Incident[]
  recent: readonly Incident[]
}>

const HistoryQuery = z.object({
  minutes: intQuery({ fallback: DEFAULT_HISTORY_MINUTES, min: 2, max: MAX_HISTORY_MINUTES }),
})

const IncidentQuery = z.object({
  hours: intQuery({ fallback: DEFAULT_INCIDENT_HOURS, min: 1, max: MAX_INCIDENT_HOURS }),
})

/**
 * One metric family's history for the whole fleet, read through one session.
 * What the numbers mean is `fleetHistory` in series.ts.
 */
const metricHistory = ({ kind, minutes }: { kind: Kind; minutes: number }): MetricHistoryView => {
  const now = new Date()
  return session({
    path: dbPath(),
    mode: 'read',
    work: (connection) => fleetHistory({ connection, kind, minutes, now }),
  })
}

/**
 * The one route the gate leaves open: the container healthcheck and the
 * Funnel both probe it without a session.
 */
@Controller()
export class HealthController {
  /**
   * Liveness plus staleness.
   *
   * The collector runs on a box it also monitors, so it cannot report that
   * box being down. Staleness is how that blind spot surfaces instead of a
   * frozen green dashboard.
   */
  @Get('health')
  health(): HealthView {
    const now = new Date()
    const age = session({
      path: dbPath(),
      mode: 'read',
      work: (connection) => ageSeconds({ now, at: lastHeartbeat(connection) }),
    })
    return {
      ok: true,
      heartbeat_age_seconds: age,
      stale: age === null || age > STALE_AFTER_SECONDS,
    }
  }
}

@Controller()
@UseGuards(SupabaseAdminGuard)
export class FleetController {
  /**
   * Every configured host's latest vitals, plus fleet-wide staleness.
   *
   * One session for the whole response: it used to open three connections
   * per host plus two, so answering for five hosts cost seventeen. What the
   * flags on each host mean, and why staleness is judged per metric family,
   * is `fleetView` in fleet.ts.
   */
  @Get('fleet')
  fleet(): FleetView {
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) => fleetView({ connection, now: new Date() }),
    })
  }

  /** Aggregate CPU busy percent per host, derived from the jiffy counters. */
  @Get('fleet/cpu')
  cpu(@Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>): MetricHistoryView {
    return metricHistory({ kind: 'cpu', minutes: query.minutes })
  }

  /** Used memory percent per host, judged against MemAvailable. */
  @Get('fleet/memory')
  memory(@Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>): MetricHistoryView {
    return metricHistory({ kind: 'memory', minutes: query.minutes })
  }

  /**
   * Intel iGPU frequency as a share of its ceiling, per host.
   *
   * A load proxy, not utilization: DSM exposes no true busy percentage. Only
   * vermithor and vhagar have a render node, so the other three are empty
   * here permanently rather than pending a fix.
   */
  @Get('fleet/gpu')
  gpu(@Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>): MetricHistoryView {
    return metricHistory({ kind: 'gpu', minutes: query.minutes })
  }

  /** Total bytes per second per host, received plus sent, every NIC summed. */
  @Get('fleet/network')
  network(@Query({ schema: HistoryQuery }) query: z.infer<typeof HistoryQuery>): MetricHistoryView {
    return metricHistory({ kind: 'network', minutes: query.minutes })
  }

  @Get('incidents')
  incidents(@Query({ schema: IncidentQuery }) query: z.infer<typeof IncidentQuery>): IncidentFeed {
    const since = addSeconds({ at: new Date(), seconds: -query.hours * 3600 })
    return session({
      path: dbPath(),
      mode: 'read',
      work: (connection) => ({
        open: openIncidents(connection),
        recent: history({ connection, since }),
      }),
    })
  }
}
