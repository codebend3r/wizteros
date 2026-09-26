import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectContainers,
  collectHost,
  collectSlow,
  type CompactJob,
  type GetJson,
  initDb,
  isSlowRound,
  type Loop,
  PARSERS,
  type RunSsh,
  runAll,
  runForever,
  samplesFromSections,
  tick,
} from '@/collector.js'
import { HOSTS, host, SLOW_TIMEOUT, VITALS_TIMEOUT } from '@/config.js'
import { session } from '@/db.js'
import { checkResult, history, type CheckResult, observedRun, openIncidents } from '@/incidents.js'
import { lastHeartbeat, latest, series } from '@/store.js'
import { logRaised } from '@/tasks.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { addSeconds } from '@/time.js'
import type { HttpResult } from '@/transport/http.js'
import type { SshResult } from '@/transport/ssh.js'

const MINUTE = 60
const HOUR = 3600
const DAY = 24 * HOUR

const T0 = new Date(Date.UTC(2026, 7, 10, 12, 0, 0))

/** T0 moved by a number of seconds, the `T0 + timedelta(...)` of the Python tests. */
const at = (seconds: number): Date => addSeconds({ at: T0, seconds })

// these tests are about what the collector writes, not about the age floor
// `latest` takes, so the floor is set wide enough that it never decides an
// assertion here
const ANY_AGE = at(-30 * DAY)

const SECTIONS: Readonly<Record<string, string>> = {
  stat: 'cpu  100 0 50 900 0 0 0 0 0 0\n',
  meminfo: 'MemTotal:  1683776 kB\nMemAvailable: 741756 kB\n',
  netdev: 'h1\nh2\n  eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0\n',
  loadavg: '0.20 0.18 0.12 1/721 21708\n',
  uptime: '950412.67 3698765.43\n',
  gpu: '',
}

const SLOW_SECTIONS: Readonly<Record<string, string>> = {
  df:
    'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
    '/dev/mapper/cachedev_0 100 40 60 40% /volume1\n',
}

// One session per assertion, the same way the collector and the API open one
// per unit of work. store and incidents take a connection, so a test that wants
// to see what a path-taking call wrote has to open the file the same way.
const latestOf = ({
  path,
  target,
  since = ANY_AGE,
}: {
  path: string
  target: string
  since?: Date
}): Record<string, number> =>
  session({ path, work: (connection) => latest({ connection, target, since }) })

const seriesOf = ({
  path,
  target,
  metric,
  since,
}: {
  path: string
  target: string
  metric: string
  since: Date
}) => session({ path, work: (connection) => series({ connection, target, metric, since }) })

const lastHeartbeatOf = (path: string): Date | null =>
  session({ path, work: (connection) => lastHeartbeat(connection) })

const openIncidentsOf = (path: string) =>
  session({ path, work: (connection) => openIncidents(connection) })

const historyOf = ({ path, since }: { path: string; since: Date }) =>
  session({ path, work: (connection) => history({ connection, since }) })

const observedRunOf = ({ path, target }: { path: string; target: string }) =>
  session({ path, work: (connection) => observedRun({ connection, target }) })

// The docker host used by every container test. Its url is deliberately
// unresolvable: every test fakes the transport, so a leaked real request fails
// loudly instead of touching the LAN.
const DOCKER_HOST = host({
  name: 'meleys',
  ip: '192.0.2.2',
  has_gpu: false,
  docker_url: 'http://proxy.invalid:2375',
})

/** Re-assemble a sections record into the sentinel-delimited wire format. */
const stdoutOf = (sections: Readonly<Record<string, string>>): string =>
  Object.entries(sections)
    .map(([name, body]) => `###${name}\n${body}`)
    .join('')

const freshDb = (): string => {
  const path = tempDbPath()
  initDb(path)
  return path
}

/** An ssh.run replacement that answers every host with one canned result. */
const fakeSsh =
  (result: SshResult): RunSsh =>
  async () =>
    result

/** A http.getJson replacement that answers every url with one result. */
const fakeHttp =
  (result: HttpResult): GetJson =>
  async () =>
    result

const sshResult = ({
  ok,
  stdout = '',
  reason = '',
}: {
  ok: boolean
  stdout?: string
  reason?: string
}): SshResult => ({ ok, stdout, reason })

/** Await `step` for each index in turn, as the Python tests awaited inside a for loop. */
const inTurn = <T>({
  indexes,
  step,
}: {
  indexes: readonly number[]
  step: (index: number) => Promise<T>
}): Promise<readonly T[]> =>
  indexes.reduce<Promise<readonly T[]>>(
    async (done, index) => [...(await done), await step(index)],
    Promise.resolve([]),
  )

const entry = ({
  name,
  state = 'running',
  status = 'Up 2 days',
}: {
  name: string
  state?: string
  status?: string
}) => ({ Names: [`/${name}`], State: state, Status: status })

const dockerOk = (...entries: readonly unknown[]): HttpResult => ({
  ok: true,
  status: 200,
  body: JSON.stringify(entries),
  reason: '',
})

const DOCKER_REFUSED: HttpResult = { ok: false, status: 0, body: '', reason: 'refused' }

const targets = (checks: readonly CheckResult[]): ReadonlySet<string> =>
  new Set(checks.map((check) => check.target))

const openTargets = (path: string): ReadonlySet<string> =>
  new Set(openIncidentsOf(path).map((incident) => incident.target))

const metricsOf = (samples: readonly { metric: string }[]): ReadonlySet<string> =>
  new Set(samples.map((sample) => sample.metric))

afterEach(removeTempDirs)

describe('samplesFromSections', () => {
  it('merges every parser', () => {
    const got = metricsOf(samplesFromSections({ sections: SECTIONS }))

    expect(got).toContain('cpu.total.user')
    expect(got).toContain('mem.total_bytes')
    expect(got).toContain('net.eth0.rx_bytes')
    expect(got).toContain('load.1m')
    expect(got).toContain('uptime.seconds')
  })

  it('skips a missing section', () => {
    // a truncated response must still yield whatever did arrive
    const got = metricsOf(samplesFromSections({ sections: { loadavg: '0.1 0.2 0.3 1/2 3\n' } }))

    expect(got).toEqual(new Set(['load.1m', 'load.5m', 'load.15m', 'procs.running', 'procs.total']))
  })

  it('yields nothing on an empty response', () => {
    expect(samplesFromSections({ sections: {} })).toEqual([])
  })

  it('covers the slow tier sections', () => {
    const got = metricsOf(samplesFromSections({ sections: SLOW_SECTIONS }))

    expect(got).toContain('disk.volume1.used_percent')
  })

  it('keeps an empty section empty', () => {
    // "collected, nothing there" is not an error, and it is not a sample either
    expect(samplesFromSections({ sections: { gpu: '' } })).toEqual([])
  })

  it('never discards the other sections for one bad section', () => {
    // the parsers run in one flat pass, so without per-section isolation a
    // single malformed byte anywhere costs every section for that host
    const explode = (): never => {
      throw new Error('malformed')
    }

    const got = metricsOf(
      samplesFromSections({ sections: SECTIONS, parsers: { ...PARSERS, loadavg: explode } }),
    )

    expect(got).not.toContain('load.1m')
    expect(got).toContain('cpu.total.user')
    expect(got).toContain('mem.total_bytes')
    expect(got).toContain('uptime.seconds')
  })
})

describe('collectHost', () => {
  it('records a failure for an unroutable ip', async () => {
    // faked at the transport seam rather than spawning a real ssh at 192.0.2.1:
    // no test in this package may leave the process
    const db = freshDb()
    const ghost = host({ name: 'ghost', ip: '192.0.2.1', has_gpu: false, docker_url: '' })

    const result = await collectHost({
      host: ghost,
      at: T0,
      path: db,
      timeout: 2,
      run: fakeSsh(sshResult({ ok: false, reason: 'unreachable' })),
    })

    expect(result).toHaveLength(1)
    const [check] = result
    expect(check.ok).toBe(false)
    expect(check.target).toBe('host:ghost')
    expect(check.reason).not.toBe('')
    // nothing collected must not look like a healthy empty host
    expect(latestOf({ path: db, target: 'host:ghost' })).toEqual({})
  })

  it('writes samples on success', async () => {
    const db = freshDb()

    const result = await collectHost({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SECTIONS) })),
    })

    expect(result).toEqual([checkResult({ target: 'host:meleys', ok: true, reason: '' })])
    expect(latestOf({ path: db, target: 'host:meleys' })['load.1m']).toBe(0.2)
  })

  it('writes no samples when ssh fails', async () => {
    const db = freshDb()

    const result = await collectHost({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: false, reason: 'timeout' })),
    })

    expect(result).toHaveLength(1)
    const [check] = result
    expect(check.ok).toBe(false)
    expect(check.reason).toBe('timeout')
    expect(latestOf({ path: db, target: 'host:meleys' })).toEqual({})
  })

  it('records no host check for a local spawn failure', async () => {
    // ssh missing from PATH, or the collector out of file descriptors: a fault
    // on this side of the wire that says nothing about the host. Recording it
    // would open an incident on all five boxes at once and crater every
    // uptime_percent_24h for a day.
    const db = freshDb()
    const run = fakeSsh(sshResult({ ok: false, reason: 'spawn_error' }))

    const results = await inTurn({
      indexes: [0, 1, 2, 3],
      step: (index) => collectHost({ host: DOCKER_HOST, at: at(30 * index), path: db, run }),
    })

    expect(results).toEqual([[], [], [], []])
    expect(openIncidentsOf(db)).toEqual([])
    expect(historyOf({ path: db, since: at(-HOUR) })).toEqual([])
    expect(latestOf({ path: db, target: 'host:meleys' })).toEqual({})
  })

  it('is not a healthy check when a successful probe measured nothing', async () => {
    // ssh exited 0 but the payload is unparseable: the box was observed and
    // none of it was measured. Recording ok=true with zero samples is a fourth
    // state the taxonomy does not allow, and it reads as healthy.
    const db = freshDb()

    const result = await collectHost({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: true, stdout: 'garbage, no sentinels' })),
    })

    expect(result).toHaveLength(1)
    const [check] = result
    expect(check.ok).toBe(false)
    expect(check.reason).toBe('empty_payload')
    expect(latestOf({ path: db, target: 'host:meleys' })).toEqual({})
  })

  it('stamps an aware utc timestamp', async () => {
    // store round-trips through isoformat(); a stamp without its offset
    // silently changes the stored string and breaks every comparison
    // downstream. A Date is always an instant, so the offset is asserted on
    // the stored text itself.
    const db = freshDb()

    await collectHost({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SECTIONS) })),
    })
    const points = seriesOf({
      path: db,
      target: 'host:meleys',
      metric: 'load.1m',
      since: at(-MINUTE),
    })
    const stored = session({
      path: db,
      work: (connection) =>
        connection
          .prepare("SELECT DISTINCT at FROM samples WHERE target = 'host:meleys'")
          .pluck()
          .all(),
    })

    expect(points).toHaveLength(1)
    expect(points[0][0]).toEqual(T0)
    expect(stored).toEqual(['2026-08-10T12:00:00+00:00'])
  })

  it('opens a host incident for a host that fails ssh', async () => {
    // the host itself was observed, so its failure is a real failed check and
    // must be recorded, unlike the containers behind an unreachable endpoint
    const db = freshDb()
    const run = fakeSsh(sshResult({ ok: false, reason: 'unreachable' }))

    await collectHost({ host: DOCKER_HOST, at: T0, path: db, run })
    await collectHost({ host: DOCKER_HOST, at: at(30), path: db, run })

    expect(openTargets(db)).toEqual(new Set(['host:meleys']))
  })
})

describe('the probe timeouts', () => {
  it('are the configured ones for the collector', async () => {
    // the other end of the MAX_ROUND_SECONDS derivation in config: it is only
    // honest while the collector actually spends these budgets. Python read
    // the keyword defaults; here the defaults are observed as they reach ssh.
    const db = freshDb()
    const run = vi.fn<RunSsh>(fakeSsh(sshResult({ ok: false, reason: 'timeout' })))

    await collectHost({ host: DOCKER_HOST, at: T0, path: db, run })
    await collectSlow({ host: DOCKER_HOST, at: T0, path: db, run })

    expect(run.mock.calls.map(([call]) => call.timeout)).toEqual([VITALS_TIMEOUT, SLOW_TIMEOUT])
  })
})

describe('logRaised', () => {
  it('never swallows a cancelled job', () => {
    // an abort is the process being torn down, not a job that failed;
    // absorbing it makes graceful shutdown impossible
    const aborted: unknown = AbortSignal.abort().reason

    expect(() =>
      logRaised({ label: 'tick', outcomes: [{ status: 'rejected', reason: aborted }] }),
    ).toThrow(expect.objectContaining({ name: 'AbortError' }))
  })
})

describe('collectSlow', () => {
  it('writes the slow tier samples', async () => {
    const db = freshDb()

    await collectSlow({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SLOW_SECTIONS) })),
    })

    expect(latestOf({ path: db, target: 'host:meleys' })['disk.volume1.used_percent']).toBe(40.0)
  })

  it('never folds a second check into the streak', async () => {
    // the slow tier rides the same ssh path as vitals against the same host. If
    // it recorded its own check, one failed vitals round plus one failed slow
    // round at the same instant would reach the 2-failure threshold on their
    // own, halving the hysteresis that makes an incident mean something
    const db = freshDb()
    const run = fakeSsh(sshResult({ ok: false, reason: 'timeout' }))

    await collectHost({ host: DOCKER_HOST, at: T0, path: db, run })
    await collectSlow({ host: DOCKER_HOST, at: T0, path: db, run })

    expect(openIncidentsOf(db)).toEqual([])
  })

  it('writes nothing when ssh fails', async () => {
    const db = freshDb()

    await collectSlow({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: false, reason: 'timeout' })),
    })

    expect(latestOf({ path: db, target: 'host:meleys' })).toEqual({})
  })
})

describe('collectContainers', () => {
  it('is a no-op without a docker url', async () => {
    const db = freshDb()
    const caraxes = host({ name: 'caraxes', ip: '192.168.50.4', has_gpu: false, docker_url: '' })

    expect(await collectContainers({ host: caraxes, at: T0, path: db })).toEqual([])
    expect(latestOf({ path: db, target: 'host:caraxes' })).toEqual({})
  })

  it('checks every container', async () => {
    const db = freshDb()

    const checks = await collectContainers({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      getJson: fakeHttp(
        dockerOk(
          entry({ name: 'sonarr' }),
          entry({ name: 'radarr', state: 'exited', status: 'Exited' }),
        ),
      ),
    })
    const byTarget = new Map(checks.map((check) => [check.target, check] as const))

    expect(new Set(byTarget.keys())).toEqual(
      new Set(['docker:meleys', 'container:meleys/sonarr', 'container:meleys/radarr']),
    )
    expect(byTarget.get('docker:meleys')?.ok ?? null).toBe(true)
    expect(byTarget.get('container:meleys/sonarr')?.ok ?? null).toBe(true)
    expect(byTarget.get('container:meleys/radarr')?.ok ?? null).toBe(false)
    expect(byTarget.get('container:meleys/radarr')?.reason ?? null).toBe('not_running')
    expect(latestOf({ path: db, target: 'host:meleys' })['container.sonarr.up']).toBe(1.0)
  })

  it('names an unhealthy container', async () => {
    // running but failing its healthcheck is a distinct reason from stopped;
    // an incident opened with an empty reason tells the operator nothing
    const db = freshDb()

    const checks = await collectContainers({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      getJson: fakeHttp(dockerOk(entry({ name: 'plex', status: 'Up 3 hours (unhealthy)' }))),
    })
    const byTarget = new Map(checks.map((check) => [check.target, check] as const))

    expect(byTarget.get('container:meleys/plex')?.ok ?? null).toBe(false)
    expect(byTarget.get('container:meleys/plex')?.reason ?? null).toBe('unhealthy')
  })

  it('records the docker endpoint when it fails', async () => {
    // the socket proxy is a target the collector really did observe, so its
    // failure is a real failed check
    const db = freshDb()

    const checks = await collectContainers({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      getJson: fakeHttp(DOCKER_REFUSED),
    })

    expect(targets(checks)).toEqual(new Set(['docker:meleys']))
    expect(checks[0].ok).toBe(false)
    expect(checks[0].reason).toBe('refused')
  })

  it('reports bad json without touching containers', async () => {
    const db = freshDb()

    const checks = await collectContainers({
      host: DOCKER_HOST,
      at: T0,
      path: db,
      getJson: fakeHttp({ ok: true, status: 200, body: '<html>nope', reason: '' }),
    })

    expect(targets(checks)).toEqual(new Set(['docker:meleys']))
    expect(checks[0].reason).toBe('bad_json')
  })

  it('never reads a json object body as an empty fleet', async () => {
    // a socket proxy answering 200 {"message": "page not found"} is valid JSON,
    // so it clears the decode guard, and it parses to zero containers. Treating
    // that as "this host runs nothing" would record the endpoint as ok and hand
    // retireAbsent an empty seen, closing every live container incident as
    // "removed" and wiping its streak.
    const db = freshDb()
    const exited = fakeHttp(dockerOk(entry({ name: 'sonarr', state: 'exited' })))
    await collectContainers({ host: DOCKER_HOST, at: T0, path: db, getJson: exited })
    await collectContainers({ host: DOCKER_HOST, at: at(30), path: db, getJson: exited })
    expect(openTargets(db)).toEqual(new Set(['container:meleys/sonarr']))

    const checks = await collectContainers({
      host: DOCKER_HOST,
      at: at(5 * MINUTE),
      path: db,
      getJson: fakeHttp({
        ok: true,
        status: 200,
        body: '{"message":"page not found"}',
        reason: '',
      }),
    })

    expect(targets(checks)).toEqual(new Set(['docker:meleys']))
    expect(checks[0].ok).toBe(false)
    expect(checks[0].reason).toBe('bad_json')
    const rows = historyOf({ path: db, since: at(-HOUR) })
    expect(rows).toHaveLength(1)
    expect(rows[0].closed_at).toBeNull()
    expect(rows[0].reason).not.toBe('removed')
  })

  it('never fabricates a container incident for an unreachable docker host', async () => {
    // meleys and vhagar have no socket proxy deployed, so this is every tick in
    // production today. Recording ok=false per container would open an incident
    // for every container on both boxes, forever.
    const db = freshDb()
    const getJson = fakeHttp(DOCKER_REFUSED)

    await inTurn({
      indexes: [0, 1, 2, 3],
      step: (index) =>
        collectContainers({ host: DOCKER_HOST, at: at(30 * index), path: db, getJson }),
    })

    expect(openTargets(db)).toEqual(new Set(['docker:meleys']))
  })

  it('never closes a real container incident for an unreachable docker host', async () => {
    // the other half of the trap: recording ok=true for containers we could not
    // see would silently close an outage that is still happening
    const db = freshDb()
    const exited = fakeHttp(dockerOk(entry({ name: 'sonarr', state: 'exited' })))
    await collectContainers({ host: DOCKER_HOST, at: T0, path: db, getJson: exited })
    await collectContainers({ host: DOCKER_HOST, at: at(30), path: db, getJson: exited })
    expect(openTargets(db)).toEqual(new Set(['container:meleys/sonarr']))

    const refused = fakeHttp(DOCKER_REFUSED)
    await inTurn({
      indexes: [2, 3, 4, 5],
      step: (index) =>
        collectContainers({ host: DOCKER_HOST, at: at(30 * index), path: db, getJson: refused }),
    })

    const stillOpen = new Map(
      openIncidentsOf(db).map((incident) => [incident.target, incident] as const),
    )
    expect(stillOpen.has('container:meleys/sonarr')).toBe(true)
    expect(stillOpen.get('container:meleys/sonarr')?.reason ?? null).toBe('not_running')
  })

  it('never retires a live container for an unreachable docker host', async () => {
    // retireAbsent is driven by the observed container set; an empty `seen`
    // from a failed fetch would close every container incident as "removed"
    const db = freshDb()
    const exited = fakeHttp(dockerOk(entry({ name: 'sonarr', state: 'exited' })))
    await collectContainers({ host: DOCKER_HOST, at: T0, path: db, getJson: exited })
    await collectContainers({ host: DOCKER_HOST, at: at(30), path: db, getJson: exited })

    await collectContainers({
      host: DOCKER_HOST,
      at: at(5 * MINUTE),
      path: db,
      getJson: fakeHttp(DOCKER_REFUSED),
    })

    const rows = historyOf({ path: db, since: at(-HOUR) })
    expect(rows).toHaveLength(1)
    expect(rows[0].closed_at).toBeNull()
    expect(rows[0].reason).not.toBe('removed')
  })

  it('retires a container that is gone on a successful fetch', async () => {
    const db = freshDb()
    const exited = fakeHttp(dockerOk(entry({ name: 'oldapp', state: 'exited' })))
    await collectContainers({ host: DOCKER_HOST, at: T0, path: db, getJson: exited })
    await collectContainers({ host: DOCKER_HOST, at: at(30), path: db, getJson: exited })
    expect(openTargets(db)).toEqual(new Set(['container:meleys/oldapp']))

    await collectContainers({
      host: DOCKER_HOST,
      at: at(5 * MINUTE),
      path: db,
      getJson: fakeHttp(dockerOk(entry({ name: 'sonarr' }))),
    })

    expect(openIncidentsOf(db)).toEqual([])
    expect(historyOf({ path: db, since: at(-HOUR) })[0].reason).toBe('removed')
  })
})

describe('tick', () => {
  it('leaves no host check in the tick on a spawn failure', async () => {
    const db = freshDb()

    const checks = await tick({
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: false, reason: 'spawn_error' })),
      getJson: fakeHttp(DOCKER_REFUSED),
    })

    expect(checks.some((check) => check.target.startsWith('host:'))).toBe(false)
  })

  it('leaves the hosts uptime unknown on a spawn failure', async () => {
    // the whole shape of the bug: ssh cannot be spawned, so no host check is
    // recorded (correctly, since a fault on this side says nothing about any
    // host) while the docker endpoints beside them do record one every tick.
    // Coverage tracked collector-wide therefore ran on unbroken, and every host
    // scored a flawless day over hours in which not one of them was observed.
    const db = freshDb()
    const run = fakeSsh(sshResult({ ok: false, reason: 'spawn_error' }))
    const getJson = fakeHttp(DOCKER_REFUSED)

    await inTurn({
      indexes: [0, 1, 2, 3],
      step: (index) => tick({ at: at(30 * index), path: db, run, getJson }),
    })

    expect(observedRunOf({ path: db, target: 'host:meleys' })).toBeNull()
    // the endpoint beside it was observed on every one of those ticks, which is
    // exactly why a collector-wide mark could not tell the difference
    expect(observedRunOf({ path: db, target: 'docker:meleys' })?.since ?? null).toEqual(T0)
  })

  it('covers every host and every docker host', async () => {
    const db = freshDb()

    const checks = await tick({
      at: T0,
      path: db,
      run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SECTIONS) })),
      getJson: fakeHttp(dockerOk(entry({ name: 'sonarr' }))),
    })
    const all = [...targets(checks)]

    expect(new Set(all.filter((target) => target.startsWith('host:')))).toEqual(
      new Set(HOSTS.map((each) => `host:${each.name}`)),
    )
    expect(new Set(all.filter((target) => target.startsWith('container:')))).toEqual(
      new Set(
        HOSTS.filter((each) => !!each.docker_url).map((each) => `container:${each.name}/sonarr`),
      ),
    )
    expect(lastHeartbeatOf(db)).toEqual(T0)
  })

  it('records no container result for hosts it could not observe', async () => {
    // today's production shape: every host answers ssh, no host answers docker
    const db = freshDb()
    const run = fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SECTIONS) }))
    const getJson = fakeHttp(DOCKER_REFUSED)

    await tick({ at: T0, path: db, run, getJson })
    const checks = await tick({ at: at(30), path: db, run, getJson })

    expect(checks.some((check) => check.target.startsWith('container:'))).toBe(false)
    expect(openTargets(db)).toEqual(
      new Set(HOSTS.filter((each) => !!each.docker_url).map((each) => `docker:${each.name}`)),
    )
  })

  it('survives one wedged host', async () => {
    const db = freshDb()
    const run: RunSsh = async ({ host: ip }) => {
      if (ip === '192.168.50.4') {
        throw new Error('wedged')
      }
      return sshResult({ ok: true, stdout: stdoutOf(SECTIONS) })
    }

    const checks = await tick({ at: T0, path: db, run, getJson: fakeHttp(DOCKER_REFUSED) })

    expect(targets(checks)).not.toContain('host:caraxes')
    expect(targets(checks)).toContain('host:vermithor')
    expect(lastHeartbeatOf(db)).toEqual(T0)
  })
})

describe('isSlowRound', () => {
  it('fires on the first round and every thirtieth', () => {
    expect(isSlowRound(0)).toBe(true)
    expect(Array.from({ length: 29 }, (_, offset) => offset + 1).filter(isSlowRound)).toEqual([])
    expect(isSlowRound(30)).toBe(true)
  })
})

// No Python counterpart: run_forever and run_all had no tests, and these pin
// the two seams the port added, the injectable compaction and the abort that
// stops both loops.
describe('runForever', () => {
  it('runs a whole first round, compacts, and returns once aborted', async () => {
    const db = tempDbPath()
    const controller = new AbortController()
    const jobs: CompactJob[] = []

    await runForever({
      path: db,
      signal: controller.signal,
      run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf({ ...SECTIONS, ...SLOW_SECTIONS }) })),
      getJson: fakeHttp(DOCKER_REFUSED),
      compact: (job) => {
        jobs.push(job)
        controller.abort()
      },
    })

    expect(jobs).toHaveLength(1)
    expect(jobs[0].path).toBe(db)
    // one instant stamps the whole round: the tick, the slow tier and the
    // compaction all judge against the same `now`
    expect(lastHeartbeatOf(db)).toEqual(jobs[0].now)
    expect(latestOf({ path: db, target: 'host:meleys' })['disk.volume1.used_percent']).toBe(40.0)
  })

  it('rejects when the compaction fails', async () => {
    // Python let the exception out of to_thread and out of the loop, which
    // ended the process; the port keeps that rather than looping on a broken
    // compaction
    const db = tempDbPath()

    await expect(
      runForever({
        path: db,
        run: fakeSsh(sshResult({ ok: true, stdout: stdoutOf(SECTIONS) })),
        getJson: fakeHttp(DOCKER_REFUSED),
        compact: async () => {
          throw new Error('disk full')
        },
      }),
    ).rejects.toThrow('disk full')
  })
})

describe('runAll', () => {
  it('runs both loops on the one file and signal', async () => {
    const controller = new AbortController()
    const vitalsLoop = vi.fn<Loop>(async () => undefined)
    const plexLoop = vi.fn<Loop>(async () => undefined)

    await runAll({ path: '/data/fleet.db', signal: controller.signal, vitalsLoop, plexLoop })

    expect(vitalsLoop).toHaveBeenCalledWith({ path: '/data/fleet.db', signal: controller.signal })
    expect(plexLoop).toHaveBeenCalledWith({ path: '/data/fleet.db', signal: controller.signal })
  })
})
