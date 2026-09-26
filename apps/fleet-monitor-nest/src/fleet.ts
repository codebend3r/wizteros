// What the dashboard says about a host, and why.
//
// Judgments rather than readings: how many cores a box turned out to have, how
// long a metric family has been quiet, whether a host needs attention. They live
// here rather than in the SPA because they need fleet knowledge (which volume
// is monitored, which keys carry memory, what counts as too full), and the
// browser is a wire away from the code that chose those names.
//
// Nothing here opens a session. Every function takes the connection the route
// already has, so answering for the whole fleet costs one.

import { HOSTS, type Host, SLOW_INTERVAL, VITALS_INTERVAL } from '@/config.js'
import type { Connection } from '@/db.js'
import { observedRun, uptimePercent } from '@/incidents.js'
import { type ContainerView, fromSamples } from '@/probes/docker.js'
import { pythonRound } from '@/pythonMath.js'
import { MEMORY_AVAILABLE_METRIC, MEMORY_TOTAL_METRIC } from '@/series.js'
import { coverageSince, lastHeartbeat, latest, metricAges } from '@/store.js'
import { addSeconds, secondsBetween } from '@/time.js'

// Three missed vitals ticks. Past this the dashboard is showing history, not
// the present, and must say so. This is collector liveness only: it says
// nothing about whether any given metric was recently observed.
export const STALE_AFTER_SECONDS = VITALS_INTERVAL * 3

// Three missed slow-tier ticks (disk, temperatures: collected every
// SLOW_INTERVAL, not every VITALS_INTERVAL). A metric older than this has
// outlived even its slowest expected refresh, not just an unlucky round.
export const METRICS_STALE_AFTER_SECONDS = SLOW_INTERVAL * 3

// A metric nothing has produced for a day is a source that went away (a veth
// renamed by a container restart, a hwmon chip that disappeared), not a late
// reading. Counting it forever would pin `metrics_stale` true on a healthy
// host. Deliberately far above METRICS_STALE_AFTER_SECONDS: everything between
// the two still reads as stale, which is the whole detection band.
//
// It bounds what is reported, not just what is aged. Samples live seven days,
// so past this window a reading is still on disk with no age the window can
// express, and reporting the value while dropping its age is how a week-old
// disk number came back beside a bare "Healthy". Both reads take this floor.
export const METRIC_AGE_WINDOW_SECONDS = 24 * 3600

// When a host needs attention. These live here, beside the staleness bands they
// sit next to, rather than in the SPA: they are judgments about the fleet, and
// the browser is not where the fleet is known.
export const DISK_WARN_PERCENT = 90
export const LOAD_WARN_PER_CORE = 1

// The collector only ever runs `df -Pk /volume1`, so this is the one volume the
// monitor can report on. Which volume that is, and which keys carry memory, are
// facts about what the collector collects: they belong beside it rather than in
// a browser a wire away from the code that chose the names. The mount is
// reported on every host for the same reason: the card prints it beside the
// free-space figure, and the SPA must not hardcode which volume it is looking
// at.
//
// The memory keys are read from the series module rather than restated here:
// the card and the memory chart must never disagree about which gauge means
// "used".
export const DISK_PERCENT_METRIC = 'disk.volume1.used_percent'
export const DISK_TOTAL_METRIC = 'disk.volume1.total_bytes'
export const DISK_AVAILABLE_METRIC = 'disk.volume1.available_bytes'
export const DISK_MOUNT = '/volume1'

// /proc/stat emits one row per cpu, so the core count is observed every tick
// rather than declared anywhere. `cpu.total` is the aggregate row and is named
// so it cannot match.
//
// Spelled to match what Python's `re.match(r"^cpu\d+\.user$")` accepts: `\d`
// there is any Unicode decimal digit, and `$` also matches before one trailing
// newline.
const CORE_METRIC = /^cpu\p{Nd}+\.user\n?$/u

export type HostState = 'ok' | 'warn' | 'unknown'

/**
 * One host as the dashboard sees it.
 *
 * Carries the raw `metrics` map and the judgments drawn from it. The
 * judgments are here rather than in the SPA because they need fleet
 * knowledge: which volume is monitored, how many cores the box turned out to
 * have, what counts as too full.
 */
export type HostView = Readonly<{
  name: string
  ip: string
  has_gpu: boolean
  has_docker: boolean
  collected: boolean
  status: HostState
  cores: number | null
  load_per_core: number | null
  memory_percent: number | null
  memory_total_bytes: number | null
  disk_percent: number | null
  disk_total_bytes: number | null
  disk_available_bytes: number | null
  disk_mount: string
  containers: readonly ContainerView[]
  // the raw readings behind every field above, kept because this is a monitor
  // and the unreduced numbers are the thing being monitored
  metrics: Readonly<Record<string, number>>
  // which family carries the age below, so the page can name what fell
  // silent instead of guessing at the cause
  stalest_family: string | null
  stalest_family_age_seconds: number | null
  metrics_stale: boolean
  uptime_percent_24h: number | null
}>

export type FleetView = Readonly<{
  collected_at: Date | null
  stale: boolean
  hosts: readonly HostView[]
}>

/**
 * Seconds since `at`, or null when there is nothing to measure.
 *
 * A stamp in the future is null rather than a negative number. A clock that
 * stepped backwards leaves rows the comparisons then read as newer than now,
 * and a negative age would clear every staleness threshold: the page would
 * show frozen values and affirmatively call them fresh. Unknown is the only
 * honest answer.
 */
export const ageSeconds = ({ now, at }: { now: Date; at: Date | null }): number | null => {
  if (at === null) {
    return null
  }
  const age = secondsBetween({ from: at, to: now })
  return age >= 0 ? age : null
}

// A metric name is `family.instance.field` (`net.eth0.rx_bytes`,
// `disk.volume1.used_percent`, `container.sonarr.up`) or `family.field`
// (`load.1m`, `uptime.seconds`). The leading segment is the family: everything
// under it is one probe reading one kind of source, so it is the unit that
// falls silent together.
const familyOf = (metric: string): string => {
  const dot = metric.indexOf('.')
  return dot === -1 ? metric : metric.slice(0, dot)
}

/**
 * The metric family that has gone longest without any reading at all.
 *
 * Freshest member wins inside a family, stalest family wins across them, and
 * that asymmetry is the whole point. A plain `min` over every metric let one
 * vanished source speak for the whole host: a VPN tunnel that existed on
 * meleys for an hour left `net.tun1000.*` frozen, and because
 * METRIC_AGE_WINDOW_SECONDS is a day while METRICS_STALE_AFTER_SECONDS is 45
 * minutes, those two dead counters reported the host stale for the next 23
 * hours while `net.eth0.*` beside them updated every 30 seconds.
 *
 * A source going away is not the same event as a probe going quiet, and only
 * the second one is worth a banner. Every case the `min` was there to catch
 * still reads as stale, because it takes the whole family down: df failing,
 * the hwmon chip gone, the host unreachable.
 *
 * Skipping the vanished source at the parser is the better fix where the name
 * is predictable (see `SKIP_PREFIXES` in the proc probe), but that list can
 * only name the patterns already met, and this holds for the ones it has not.
 *
 * Two families tied for stalest go to the one met first in `ages`, which the
 * store hands over in metric order. Python iterated a set here, so its choice
 * between tied families was whatever that set's hash order gave.
 */
const stalestFamily = (ages: Readonly<Record<string, Date>>): readonly [string, Date] | null => {
  const freshest = Object.entries(ages).reduce((byFamily, [metric, at]) => {
    const family = familyOf(metric)
    const held = byFamily.get(family)
    return held !== undefined && held.getTime() >= at.getTime()
      ? byFamily
      : byFamily.set(family, at)
  }, new Map<string, Date>())
  return [...freshest.entries()].reduce<readonly [string, Date] | null>(
    (stalest, pair) =>
      stalest === null || pair[1].getTime() < stalest[1].getTime() ? pair : stalest,
    null,
  )
}

/**
 * This target's 24h availability, or null when nobody watched the window.
 *
 * Two coverage facts have to hold, and they are not the same fact.
 * `observedSince` is collector-wide and says a round happened at all; the
 * per-target run says a round observed *this* target. A spawn failure (ssh
 * missing from PATH, the process out of file descriptors) records no check
 * for any host while the docker endpoints beside them keep recording one, so
 * the collector-wide mark runs on unbroken and would score a flawless day
 * over hours in which not one host was looked at.
 */
const uptime24h = ({
  connection,
  target,
  now,
  observedSince,
}: {
  connection: Connection
  target: string
  now: Date
  observedSince: Date | null
}): number | null => {
  const run = observedRun({ connection, target })
  if (run === null || observedSince === null) {
    return null
  }
  return uptimePercent({
    connection,
    target,
    since: addSeconds({ at: now, seconds: -24 * 3600 }),
    now,
    // the later of the two starts: neither mark may widen the other's claim
    observed: {
      since: observedSince.getTime() > run.since.getTime() ? observedSince : run.since,
      until: run.until,
    },
  })
}

/**
 * How many cores this host turned out to have, or null before it reported.
 *
 * Counted from the per-cpu rows /proc/stat already sends rather than declared
 * in config. A declared number is a second copy to keep in step with a fleet
 * that is not uniform, and it goes silently wrong the day a box is replaced.
 */
export const coreCount = (metrics: Readonly<Record<string, number>>): number | null =>
  Object.keys(metrics).filter((metric) => CORE_METRIC.test(metric)).length || null

/**
 * Used memory as a percentage, or null when the host has not reported it.
 *
 * Available rather than free: free excludes reclaimable page cache, and on
 * these boxes that reads as 95% used on an idle machine.
 */
export const memoryUsedPercent = (metrics: Readonly<Record<string, number>>): number | null => {
  const total = metrics[MEMORY_TOTAL_METRIC] ?? null
  const available = metrics[MEMORY_AVAILABLE_METRIC] ?? null
  if (total === null || available === null || total <= 0) {
    return null
  }
  return pythonRound({ value: ((total - available) / total) * 100 })
}

/**
 * Whether a host needs attention.
 *
 * "not collected" is its own state; it must never render as healthy.
 */
export const hostState = ({
  collected,
  diskPercent,
  loadPerCore,
}: {
  collected: boolean
  diskPercent: number | null
  loadPerCore: number | null
}): HostState => {
  if (!collected) {
    return 'unknown'
  }
  const overDisk = diskPercent !== null && diskPercent >= DISK_WARN_PERCENT
  const overLoad = loadPerCore !== null && loadPerCore >= LOAD_WARN_PER_CORE
  return overDisk || overLoad ? 'warn' : 'ok'
}

/** One host's latest vitals and the judgments drawn from them. */
export const hostView = ({
  connection,
  host,
  now,
  observedSince,
}: {
  connection: Connection
  host: Host
  now: Date
  observedSince: Date | null
}): HostView => {
  const target = `host:${host.name}`
  // one floor, read once, for both: a value `metricAges` cannot date is a
  // value `latest` must not report
  const since = addSeconds({ at: now, seconds: -METRIC_AGE_WINDOW_SECONDS })
  const metrics = latest({ connection, target, since })
  const ages = metricAges({ connection, target, since })
  const stalest = stalestFamily(ages)
  const stalestAge = stalest === null ? null : ageSeconds({ now, at: stalest[1] })

  const cores = coreCount(metrics)
  const load = metrics['load.1m'] ?? null
  const loadPerCore = load !== null && cores !== null ? load / cores : null
  const diskPercent = metrics[DISK_PERCENT_METRIC] ?? null
  const collected = Object.keys(metrics).length > 0

  return {
    name: host.name,
    ip: host.ip,
    has_gpu: host.has_gpu,
    has_docker: !!host.docker_url,
    collected,
    status: hostState({ collected, diskPercent, loadPerCore }),
    cores,
    load_per_core: loadPerCore,
    memory_percent: memoryUsedPercent(metrics),
    memory_total_bytes: metrics[MEMORY_TOTAL_METRIC] ?? null,
    disk_percent: diskPercent,
    disk_total_bytes: metrics[DISK_TOTAL_METRIC] ?? null,
    disk_available_bytes: metrics[DISK_AVAILABLE_METRIC] ?? null,
    disk_mount: DISK_MOUNT,
    containers: [...fromSamples(metrics)],
    metrics,
    stalest_family: stalest === null ? null : stalest[0],
    stalest_family_age_seconds: stalestAge,
    metrics_stale: stalestAge === null || stalestAge > METRICS_STALE_AFTER_SECONDS,
    // a host never checked at all is unknown, not a perfect score: an empty
    // incident history must not read as proven uptime. Neither must hours
    // nothing observed this host for, whether because the collector was not
    // running or because it was running and could not see it.
    uptime_percent_24h: collected ? uptime24h({ connection, target, now, observedSince }) : null,
  }
}

/**
 * Every configured host's latest vitals, plus fleet-wide staleness.
 *
 * The top-level `stale` is heartbeat-derived, same as `/health`: it proves
 * the collector process is alive, nothing about any individual metric. Each
 * host additionally carries `metrics_stale` and `stalest_family_age_seconds`,
 * computed from the actual per-metric timestamps in the store, so a host whose
 * fast tier keeps the heartbeat fresh while its slow tier (disk,
 * temperatures) has been failing silently is still caught: `collected` is
 * true, the top-level `stale` is false, but `metrics_stale` is true because
 * one of its metric families has outlived three slow-tier ticks.
 *
 * Families, not metrics: `stalest_family` names what fell silent, and a
 * family counts as reporting while any single metric under it does. See
 * `stalestFamily` for why one dead counter must not speak for a host.
 *
 * That flag can only speak for readings inside METRIC_AGE_WINDOW_SECONDS. Past
 * a day a metric is no longer late, it is gone, and `metrics` stops carrying it
 * at the same moment `metricAges` stops dating it, so the slow tier that died
 * three days ago shows its disk reading as absent rather than as a current
 * number nothing can date. A host whose every reading has aged out that way
 * reports `collected` false, the same as one nothing has ever reached.
 *
 * The whole fleet is read through the one connection handed in. It used to
 * open three per host plus two, so answering for five hosts cost seventeen.
 */
export const fleetView = ({
  connection,
  now,
}: {
  connection: Connection
  now: Date
}): FleetView => {
  const last = lastHeartbeat(connection)
  // read once for the whole fleet: it is a property of the collector, not of
  // any one host
  const observedSince = coverageSince(connection)
  const hosts = HOSTS.map((host) => hostView({ connection, host, now, observedSince }))
  const age = ageSeconds({ now, at: last })
  return {
    collected_at: last,
    stale: age === null || age > STALE_AFTER_SECONDS,
    hosts,
  }
}
