import { Logger } from '@nestjs/common'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import {
  HOSTS,
  type Host,
  SLOW_INTERVAL,
  SLOW_TIMEOUT,
  sshUser,
  VITALS_INTERVAL,
  VITALS_TIMEOUT,
} from '@/config.js'
import { type Connection, session } from '@/db.js'
import * as incidents from '@/incidents.js'
import * as plays from '@/plays/index.js'
import { runForever as runPlexForever } from '@/plexSync.js'
import * as docker from '@/probes/docker.js'
import * as proc from '@/probes/proc.js'
import * as script from '@/probes/script.js'
import * as system from '@/probes/system.js'
import type { Sample } from '@/probes/types.js'
import * as rollups from '@/rollups.js'
import * as store from '@/store.js'
import { logRaised } from '@/tasks.js'
import * as http from '@/transport/http.js'
import * as ssh from '@/transport/ssh.js'

const log = new Logger('fleet.collector')

/** One section's parser: the section's body in, its samples out. */
export type Parser = (text: string) => readonly Sample[]

/** `ssh.run`'s shape, so a test can answer for every host without leaving the process. */
export type RunSsh = typeof ssh.run

/** `http.getJson`'s shape, for the same reason on the docker endpoint. */
export type GetJson = typeof http.getJson

/** One compaction: the file to compact and the instant it is judged against. */
export type CompactJob = Readonly<{
  path: string
  now: Date
}>

/**
 * Run one compaction to completion. The production one is `compactInWorker`;
 * a test passes something synchronous so no worker is ever spawned.
 */
export type Compact = (job: CompactJob) => Promise<void> | void

/** One of the two loops `runAll` runs side by side. */
export type Loop = (options: Readonly<{ path: string; signal: AbortSignal }>) => Promise<void>

// section name -> parser. Missing sections are skipped, never defaulted.
export const PARSERS: Readonly<Record<string, Parser>> = {
  stat: proc.parseStat,
  meminfo: proc.parseMeminfo,
  netdev: proc.parseNetDev,
  loadavg: proc.parseLoadavg,
  uptime: proc.parseUptime,
  gpu: system.parseGpuFreq,
  df: system.parseDf,
  hwmon: system.parseHwmon,
  inotify: system.parseInotify,
}

const SLOW_EVERY = Math.floor(SLOW_INTERVAL / VITALS_INTERVAL)

// Transport reasons that mean nothing was observed rather than that the target
// failed. spawn_error is raised on this side of the wire (ssh missing from
// PATH, or the process out of file descriptors), so recording it as a failed
// host check would manufacture an outage on all five hosts at once, from a
// fault none of them have. Same contract the docker endpoint already follows.
const NOT_OBSERVED: ReadonlySet<string> = new Set(['spawn_error'])

// An abort is the process being torn down: what a stopping loop sees, and the
// one rejection it returns on rather than raises.
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'

const stackOf = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? String(error)) : String(error)

/**
 * One section's samples, or none if its parser could not read it.
 *
 * The isolation is the point. Without it the whole run is one pass, and a
 * single malformed byte anywhere discards every section for that host rather
 * than the one it came from.
 */
const sectionSamples = ({
  name,
  parser,
  body,
}: {
  name: string
  parser: Parser
  body: string
}): readonly Sample[] => {
  try {
    return parser(body)
  } catch (error) {
    log.warn(`section '${name}' failed to parse (${body.length} bytes)`, stackOf(error))
    return []
  }
}

/**
 * Run every section through its parser and flatten the result.
 *
 * A section that never arrived is skipped rather than defaulted, so a
 * truncated response yields less data instead of fabricated zeroes.
 *
 * `parsers` is a parameter only so a test can stand a broken parser in for
 * one section; the collector always uses the default.
 */
export const samplesFromSections = ({
  sections,
  parsers = PARSERS,
}: {
  sections: Readonly<Record<string, string>>
  parsers?: Readonly<Record<string, Parser>>
}): readonly Sample[] =>
  Object.entries(parsers).flatMap(([name, parser]) =>
    Object.hasOwn(sections, name) ? sectionSamples({ name, parser, body: sections[name] }) : [],
  )

const probe = ({
  host,
  body,
  timeout,
  run,
}: {
  host: Host
  body: string
  timeout: number
  run: RunSsh
}): Promise<ssh.SshResult> => run({ host: host.ip, body, user: sshUser(), timeout })

const writeSections = ({
  connection,
  host,
  at,
  stdout,
}: {
  connection: Connection
  host: Host
  at: Date
  stdout: string
}): number =>
  store.writeSamples({
    connection,
    target: `host:${host.name}`,
    at,
    samples: samplesFromSections({ sections: script.splitSections(stdout) }),
  })

/**
 * One host, one vitals round trip. Empty when nothing was observed.
 *
 * The host itself is a target the collector really did observe: the ssh run
 * either worked or it did not, so either outcome is a real check and is
 * recorded. A failure writes no samples, so an unreachable box never renders
 * as a healthy empty one.
 *
 * Two cases are not that. A local spawn failure says nothing about the host,
 * so no check is recorded at all. And an ssh run that exits 0 carrying a
 * payload nothing could parse observed the box but measured none of it, which
 * is not a healthy round either: it is recorded as a failure named
 * empty_payload rather than as a success with zero samples.
 *
 * The samples and the check derived from them share one session, so a round
 * cannot leave a check recorded against readings that were never written.
 */
export const collectHost = async ({
  host,
  at,
  path,
  timeout = VITALS_TIMEOUT,
  run = ssh.run,
}: {
  host: Host
  at: Date
  path: string
  timeout?: number
  run?: RunSsh
}): Promise<readonly incidents.CheckResult[]> => {
  const result = await probe({ host, body: script.VITALS_SCRIPT, timeout, run })
  if (NOT_OBSERVED.has(result.reason)) {
    log.warn(`vitals probe for ${host.name} could not run: ${result.reason}`)
    return []
  }

  const check = session({
    path,
    work: (connection) => {
      const written = result.ok ? writeSections({ connection, host, at, stdout: result.stdout }) : 0
      const recorded = incidents.checkResult({
        target: `host:${host.name}`,
        ok: result.ok && written > 0,
        reason: result.reason || (written ? '' : 'empty_payload'),
      })
      incidents.record({ connection, result: recorded, at })
      return recorded
    },
  })
  return [check]
}

/**
 * One host, one slow-tier round trip: disks, temperatures, inotify.
 *
 * Deliberately records no check. The vitals tier already checks this exact
 * host over this exact transport every 30 seconds, and folding a second
 * result into the same streak at the same instant would halve the incident
 * hysteresis: one slow round could open or close an incident on its own.
 */
export const collectSlow = async ({
  host,
  at,
  path,
  timeout = SLOW_TIMEOUT,
  run = ssh.run,
}: {
  host: Host
  at: Date
  path: string
  timeout?: number
  run?: RunSsh
}): Promise<void> => {
  const result = await probe({ host, body: script.SLOW_SCRIPT, timeout, run })
  if (!result.ok) {
    log.warn(`slow probe failed for ${host.name}: ${result.reason}`)
    return
  }
  session({
    path,
    work: (connection) => {
      writeSections({ connection, host, at, stdout: result.stdout })
    },
  })
}

/**
 * One container's check result.
 *
 * "stopped" and "running but failing its healthcheck" stay distinct reasons,
 * because an incident opened with an empty reason tells the operator nothing.
 */
const containerCheck = ({
  host,
  state,
}: {
  host: Host
  state: docker.ContainerState
}): incidents.CheckResult => {
  const reason = !state.running ? 'not_running' : state.health === 'unhealthy' ? 'unhealthy' : ''
  return incidents.checkResult({
    target: `container:${host.name}/${state.name}`,
    ok: !reason,
    reason,
  })
}

/**
 * Record the docker endpoint's failure and nothing else.
 *
 * This is the whole not-collected contract in one place. The endpoint was
 * observed, so its failure is a real check. The containers behind it were
 * not observed at all, and record() has no way to say so: ok=false would
 * fabricate an outage for every container on the host, ok=true would
 * silently close a real one. So no container result is recorded, and
 * retireAbsent is not reached either: an empty observed set here would close
 * every live container's incident as "removed".
 */
const endpointOnly = ({
  host,
  path,
  at,
  reason,
}: {
  host: Host
  path: string
  at: Date
  reason: string
}): readonly incidents.CheckResult[] => {
  const check = incidents.checkResult({ target: `docker:${host.name}`, ok: false, reason })
  session({
    path,
    work: (connection) => {
      incidents.record({ connection, result: check, at })
    },
  })
  return [check]
}

// `json.loads`, answering a decode failure rather than raising it.
type Decoded = Readonly<{ ok: true; payload: unknown }> | Readonly<{ ok: false }>

const decode = (body: string): Decoded => {
  try {
    return { ok: true, payload: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

/**
 * Container state for one docker host, plus a per-container check.
 *
 * Returns the endpoint check first, then one check per container. On any
 * transport or payload failure only the endpoint check comes back, because
 * the containers were never observed.
 *
 * Every check on this host lands in one session. A twelve-container host used
 * to spend twelve connections and twelve transactions on a single
 * observation, so a round that died midway left half the containers with an
 * advanced streak and half without.
 */
export const collectContainers = async ({
  host,
  at,
  path,
  timeout = 8.0,
  getJson = http.getJson,
}: {
  host: Host
  at: Date
  path: string
  timeout?: number
  getJson?: GetJson
}): Promise<readonly incidents.CheckResult[]> => {
  if (!host.docker_url) {
    return []
  }

  const response = await getJson({ url: `${host.docker_url}/containers/json?all=1`, timeout })
  if (!response.ok) {
    return endpointOnly({ host, path, at, reason: response.reason })
  }

  const decoded = decode(response.body)
  if (!decoded.ok) {
    return endpointOnly({ host, path, at, reason: 'bad_json' })
  }

  // a 200 carrying an object rather than an array is a proxy error page, not
  // an empty fleet; treating it as zero containers would retire all of them
  if (!Array.isArray(decoded.payload)) {
    return endpointOnly({ host, path, at, reason: 'bad_json' })
  }

  const states = docker.parseContainers(decoded.payload)
  const endpoint = incidents.checkResult({ target: `docker:${host.name}`, ok: true, reason: '' })
  const checks = [endpoint, ...states.map((state) => containerCheck({ host, state }))]

  session({
    path,
    work: (connection) => {
      store.writeSamples({
        connection,
        target: `host:${host.name}`,
        at,
        samples: docker.toSamples(states),
      })
      checks.forEach((check) => incidents.record({ connection, result: check, at }))
      // the container set is discovered, not declared: adding jellyfin to
      // meleys needs no config change here, and removing an app must not
      // leave its incident open forever. Only reachable on the success path,
      // so `seen` is always a set the collector actually observed.
      incidents.retireAbsent({
        connection,
        prefix: `container:${host.name}/`,
        seen: new Set(states.map((state) => state.name)),
        at,
      })
    },
  })
  return checks
}

/**
 * One collection round across the whole fleet, fully concurrent.
 *
 * Every check in the returned list was recorded; every target the round
 * could not observe is simply absent from it.
 */
export const tick = async ({
  at,
  path,
  run = ssh.run,
  getJson = http.getJson,
}: {
  at: Date
  path: string
  run?: RunSsh
  getJson?: GetJson
}): Promise<readonly incidents.CheckResult[]> => {
  const hostJobs = HOSTS.map((host) => collectHost({ host, at, path, run }))
  const dockerJobs = HOSTS.filter((host) => !!host.docker_url).map((host) =>
    collectContainers({ host, at, path, getJson }),
  )
  const outcomes = await Promise.allSettled([...hostJobs, ...dockerJobs])
  const completed = logRaised({ label: 'tick', outcomes })

  session({
    path,
    work: (connection) => {
      store.writeHeartbeat({ connection, at })
    },
  })
  return completed.flat()
}

/**
 * Whether the slow tier is due on this vitals round.
 *
 * Round 0 counts, so the first round after a restart carries disk and
 * temperature data instead of leaving a 15 minute hole in the dashboard.
 */
export const isSlowRound = (index: number): boolean => index % SLOW_EVERY === 0

/**
 * Roll closed buckets up and drop what has outlived its retention.
 *
 * Synchronous on purpose, and never called directly from the loop: runForever
 * hands it to a worker thread. A connection belongs to the thread that opened
 * it, so the session is opened here, inside whichever thread ends up running
 * it.
 */
export const compactAndPrune = ({ path, now }: CompactJob): void => {
  session({
    path,
    work: (connection) => {
      rollups.RESOLUTIONS.forEach((tier) => rollups.compact({ connection, name: tier.name, now }))
      rollups.prune({ connection, now })
    },
  })
}

/**
 * `compactAndPrune` on a worker thread, settled when the worker finishes.
 *
 * The port of `asyncio.to_thread`. better-sqlite3 is synchronous and the event
 * loop is the only thread this process has, so an inline compaction would
 * stall every tick behind it. The worker opens its own session on its own
 * connection, and a compaction that throws there rejects here, exactly as the
 * exception crossed back out of `to_thread`.
 *
 * `nest build` compiles every file under src, so the worker is its compiled
 * sibling in dist.
 */
// Compactions in flight, each as a promise that settles when its thread has
// exited. A shutdown joins them before the process exits, as Python's
// interpreter shutdown joined the to_thread worker: ending a thread that is
// still inside native SQLite code, by worker.terminate() or process.exit(),
// is a V8 fatal error (exit 133), seen on the live 1.8 GB database whenever a
// `docker stop` landed mid-compaction.
const runningCompactions = new Set<Promise<void>>()

export const compactInWorker = ({ path, now }: CompactJob): Promise<void> => {
  const done = new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./compactWorker.js', import.meta.url), {
      workerData: { path, now: now.getTime() },
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`compaction worker exited with code ${code}`))
      }
    })
  })
  // tracked settled either way, so joining never throws and never leaves a
  // rejection nobody handles; the caller still sees the real outcome on `done`
  const settled = done.then(
    () => undefined,
    () => undefined,
  )
  runningCompactions.add(settled)
  void settled.then(() => runningCompactions.delete(settled))
  return done
}

/**
 * Wait until every compaction thread has finished on its own. A compaction
 * outlasting `docker stop`'s grace period is then killed with the process, the
 * same fate the Python thread met, and SQLite rolls its transaction back.
 */
export const joinCompactions = async (): Promise<void> => {
  await Promise.all(runningCompactions)
}

/**
 * Create every table this process writes. Idempotent, order-independent.
 *
 * The play-history tables are here too, although the vitals loop never
 * writes them: the API reads them, and a fresh FM_DB_PATH would otherwise
 * turn the first /plays read into a 500 on a missing table.
 */
export const initDb = (path: string): void => {
  session({
    path,
    work: (connection) => {
      store.initDb(connection)
      rollups.initDb(connection)
      incidents.initDb(connection)
      plays.initDb(connection)
    },
  })
}

/**
 * The work's own outcome, or the signal's abort, whichever comes first.
 *
 * The stand-in for cancelling an asyncio task mid-await. Neither transport
 * takes a signal, so the work itself runs on to its own timeout; it is only
 * no longer waited for, which is what lets a stop land between two awaits
 * rather than after a whole slow round.
 */
const unlessAborted = <T>({
  work,
  signal,
}: {
  work: Promise<T>
  signal: AbortSignal
}): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    // settling twice is a no-op, so whichever of the two lands second is
    // dropped, and a rejection after an abort is handled rather than floating
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })

/**
 * One round of the loop: the tick, then on a slow round the slow tier and the
 * compaction. One instant stamps all three, as `now` did in the Python loop.
 */
const round = async ({
  index,
  path,
  signal,
  run,
  getJson,
  compact,
}: {
  index: number
  path: string
  signal: AbortSignal
  run: RunSsh
  getJson: GetJson
  compact: Compact
}): Promise<void> => {
  const now = new Date()
  await unlessAborted({ work: tick({ at: now, path, run, getJson }), signal })
  if (!isSlowRound(index)) {
    return
  }
  logRaised({
    label: 'slow tier',
    outcomes: await unlessAborted({
      work: Promise.allSettled(HOSTS.map((host) => collectSlow({ host, at: now, path, run }))),
      signal,
    }),
  })
  // off the event loop: this is blocking sqlite, and a stalled loop is a
  // stalled vitals tier, which is what MAX_ROUND_SECONDS and every tolerance
  // derived from it are supposed to bound
  await unlessAborted({ work: Promise.resolve(compact({ path, now })), signal })
}

/**
 * Vitals every 30s, slow hardware and compaction every 15 minutes.
 *
 * Returns once `signal` aborts, from whichever await it was at; a failure of
 * anything else still rejects, as it raised out of the Python loop. `run`,
 * `getJson` and `compact` are parameters only so a test can drive a round
 * without the LAN or a worker.
 */
export const runForever = async ({
  path,
  signal = new AbortController().signal,
  run = ssh.run,
  getJson = http.getJson,
  compact = compactInWorker,
}: {
  path: string
  signal?: AbortSignal
  run?: RunSsh
  getJson?: GetJson
  compact?: Compact
}): Promise<void> => {
  initDb(path)
  // the loop's own state, in milliseconds on the monotonic clock. A while
  // loop and two counters rather than recursion: this never ends, and an
  // async function that returns its own next call holds every earlier
  // round's promise for as long as the process lives
  let due = performance.now()
  let rounds = 0
  try {
    while (!signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- each round is due only after the one before it
      await round({ index: rounds, path, signal, run, getJson, compact })
      rounds += 1
      // measured from when the round was due, not from when it finished, so a
      // long round is absorbed rather than added to every interval after it
      due += VITALS_INTERVAL * 1000
      // oxlint-disable-next-line no-await-in-loop -- the wait between rounds is the loop's whole cadence
      await sleep(Math.max(0, due - performance.now()), undefined, { signal })
    }
  } catch (error) {
    if (!(signal.aborted && isAbort(error))) {
      throw error
    }
  }
}

/**
 * Both loops in one process: the vitals every 30 seconds, the play history
 * on its own clock. They share the file and nothing else, and SQLite's write
 * lock plus the session's busy timeout is what keeps a thousand-row inventory
 * page from failing a vitals tick outright.
 *
 * Either loop failing rejects at once, as the Python gather raised; `signal`
 * stops both. `vitalsLoop` and `plexLoop` are parameters only for a test.
 */
export const runAll = async ({
  path,
  signal = new AbortController().signal,
  vitalsLoop = runForever,
  plexLoop = runPlexForever,
}: {
  path: string
  signal?: AbortSignal
  vitalsLoop?: Loop
  plexLoop?: Loop
}): Promise<void> => {
  await Promise.all([vitalsLoop({ path, signal }), plexLoop({ path, signal })])
}
