import { z } from 'zod'
import type { Wire } from './guard.js'

// The fleet monitor's routes: /health, /fleet, the four metric histories and
// /incidents. Every timestamp is a string here because the wire carries
// Pydantic's ISO form; the monitor's own views hold Dates until json.ts
// writes them out.

const timestamp = z.string()

/** Liveness plus staleness. Only the container healthcheck and the Funnel
    read it; the portal does not. */
export const healthSchema = z.object({
  ok: z.boolean(),
  heartbeat_age_seconds: z.number().nullable(),
  stale: z.boolean(),
})

/** The monitor's verdict on one host, reached from that host's own readings:
    `unknown` is a host never collected, not a host that is fine. */
export const hostStatusSchema = z.enum(['ok', 'warn', 'unknown'])

/** One container. `healthy` is meaningless unless `has_healthcheck` is true:
    most containers on this fleet declare no healthcheck, which is neither a
    pass nor a failure. */
export const fleetContainerSchema = z.object({
  name: z.string(),
  up: z.boolean(),
  healthy: z.boolean(),
  has_healthcheck: z.boolean(),
})

/**
 * One host as `/fleet` reports it.
 *
 * Every judgment here is made by the monitor, not by its reader: which volume
 * is watched, how many cores the box turned out to have, what counts as too
 * full. The host also carries the raw `metrics` map those judgments were
 * drawn from, which the portal does not read and so this schema leaves out.
 */
export const fleetHostSchema = z.object({
  name: z.string(),
  ip: z.string(),
  has_gpu: z.boolean(),
  has_docker: z.boolean(),
  collected: z.boolean(),
  status: hostStatusSchema,
  cores: z.number().nullable(),
  load_per_core: z.number().nullable(),
  memory_percent: z.number().nullable(),
  memory_total_bytes: z.number().nullable(),
  disk_percent: z.number().nullable(),
  disk_total_bytes: z.number().nullable(),
  disk_available_bytes: z.number().nullable(),
  /** Which volume the disk readings describe. The collector's choice,
      reported rather than hardcoded a wire away from it. */
  disk_mount: z.string(),
  containers: z.array(fleetContainerSchema),
  /** Derived from the metric timestamps, not the heartbeat: true when a whole
      metric family on this host has outlived even its slowest refresh. */
  metrics_stale: z.boolean(),
  /** Which family fell silent (`disk`, `temp`, `net`, ...), so a reader can
      name it rather than blame whichever probe is slowest in general. */
  stalest_family: z.string().nullable(),
  stalest_family_age_seconds: z.number().nullable(),
  /** null when the host has never been collected: unknown, not a perfect score. */
  uptime_percent_24h: z.number().nullable(),
})

export const fleetResponseSchema = z.object({
  collected_at: timestamp.nullable(),
  /** Collector liveness only. Says nothing about any individual metric. */
  stale: z.boolean(),
  hosts: z.array(fleetHostSchema),
})

/** Which history a response carries. One route each, all four the same shape
    on the wire. */
export const metricKindSchema = z.enum(['cpu', 'memory', 'gpu', 'network'])

/** What the numbers mean. A chart cannot pick a y-axis without it: a percent
    runs against a fixed 0-100, a throughput against a ceiling derived from
    the readings themselves. */
export const metricUnitSchema = z.enum(['percent', 'bytes_per_second'])

/** One reading. A counter-derived value (CPU busy, throughput) is stamped at
    the later of the two readings it came from and describes the interval
    since the earlier one; a gauge-derived one (memory, GPU) is stamped when
    it was read. */
export const metricPointSchema = z.object({
  at: timestamp,
  value: z.number(),
})

/** One host's series. Empty when the host reported nothing in the window: not
    observed, never zero. */
export const metricHostSeriesSchema = z.object({
  name: z.string(),
  points: z.array(metricPointSchema),
})

/** A history response. Hosts arrive in the same order as `/fleet`, which is
    what lets position bind a host to its colour on both the charts and the
    cards. */
export const metricHistorySchema = z.object({
  kind: metricKindSchema,
  unit: metricUnitSchema,
  window_minutes: z.number(),
  hosts: z.array(metricHostSeriesSchema),
})

export const incidentSchema = z.object({
  id: z.number(),
  target: z.string(),
  reason: z.string(),
  opened_at: timestamp,
  closed_at: timestamp.nullable(),
})

export const incidentFeedSchema = z.object({
  open: z.array(incidentSchema),
  recent: z.array(incidentSchema),
})

export type Health = Wire<typeof healthSchema>
export type HostStatus = Wire<typeof hostStatusSchema>
export type FleetContainer = Wire<typeof fleetContainerSchema>
export type FleetHost = Wire<typeof fleetHostSchema>
export type FleetResponse = Wire<typeof fleetResponseSchema>
export type MetricKind = Wire<typeof metricKindSchema>
export type MetricUnit = Wire<typeof metricUnitSchema>
export type MetricPoint = Wire<typeof metricPointSchema>
export type MetricHostSeries = Wire<typeof metricHostSeriesSchema>
export type MetricHistory = Wire<typeof metricHistorySchema>
export type Incident = Wire<typeof incidentSchema>
export type IncidentFeed = Wire<typeof incidentFeedSchema>
