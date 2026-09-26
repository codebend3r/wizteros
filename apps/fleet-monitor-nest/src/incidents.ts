import type { Connection } from '@/db.js'
import { asRow, asRows, fields, type Row } from '@/rows.js'
import { COVERAGE_GAP_SECONDS } from '@/store.js'
import { isoformat, parseIso, secondsBetween } from '@/time.js'
import { pythonRound } from '@/pythonMath.js'

const INCIDENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    target    TEXT NOT NULL,
    reason    TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    closed_at TEXT
)
`

const STREAK_SCHEMA = `
CREATE TABLE IF NOT EXISTS check_streak (
    target         TEXT PRIMARY KEY,
    ok_run         INTEGER NOT NULL DEFAULT 0,
    fail_run       INTEGER NOT NULL DEFAULT 0,
    last_at        TEXT NOT NULL,
    observed_since TEXT NOT NULL
)
`

export type CheckResult = Readonly<{
  target: string
  ok: boolean
  reason: string
}>

/** A check, with `reason` defaulting to empty like the Python dataclass. */
export const checkResult = ({
  target,
  ok,
  reason = '',
}: {
  target: string
  ok: boolean
  reason?: string
}): CheckResult => ({ target, ok, reason })

/**
 * One outage, open when `closed_at` is null.
 *
 * A real type rather than the row dict `SELECT *` used to hand back. That
 * made the table's shape the wire's shape, so renaming a column silently
 * reshaped the public API and the only thing describing the contract was a
 * hand-written type guard in the SPA.
 */
export type Incident = Readonly<{
  id: number
  target: string
  reason: string
  opened_at: Date
  closed_at: Date | null
}>

/**
 * The stretch of time one target was actually being checked.
 *
 * `since` is when its current unbroken run of recorded checks began, `until`
 * is when the last one landed. Both halves are load-bearing: a run that began
 * before a window but stopped inside it leaves the rest of that window
 * unobserved, and scoring it would read the collector's silence as the target
 * being up.
 */
export type ObservedRun = Readonly<{
  since: Date
  until: Date
}>

/**
 * Create this module's tables, and carry an older check_streak forward.
 *
 * CREATE TABLE IF NOT EXISTS never widens an existing table, so a database
 * written before observed_since existed would answer every check with "no
 * such column". The backfill claims only what the old row proves: the last
 * check it saw. That under-claims coverage (uptime reads Unknown until a
 * fresh run has spanned the window), which is the safe direction to be wrong.
 */
export const initDb = (connection: Connection): void => {
  connection.prepare(INCIDENTS_SCHEMA).run()
  connection.prepare(STREAK_SCHEMA).run()
  const columns = new Set(
    asRows(connection.prepare('PRAGMA table_info(check_streak)').all()).map((row) =>
      fields(row).text('name'),
    ),
  )
  if (!columns.has('observed_since')) {
    connection
      .prepare("ALTER TABLE check_streak ADD COLUMN observed_since TEXT NOT NULL DEFAULT ''")
      .run()
    connection.prepare('UPDATE check_streak SET observed_since = last_at').run()
  }
  connection
    .prepare('CREATE INDEX IF NOT EXISTS ix_incidents_target ON incidents (target, opened_at)')
    .run()
}

/** Whether `later` falls within `gap` seconds after `earlier`, and not before it. */
const withinGap = ({
  earlier,
  later,
  gap,
}: {
  earlier: Date
  later: Date
  gap: number
}): boolean => {
  const elapsed = secondsBetween({ from: earlier, to: later })
  return 0 <= elapsed && elapsed <= gap
}

/**
 * Fold one check into the streak, opening or closing an incident on the
 * threshold. Returns "opened", "closed", or null.
 *
 * Hysteresis is deliberate. A single dropped packet is not an outage, and a
 * monitor that fires on one gets ignored, which is worse than no monitor.
 *
 * This only ever sees an actual CheckResult: a probe that could not run at
 * all (a transport failure, not a failed check) has nothing to hand here,
 * and the caller must not synthesize one. Skipping the call for that tick
 * leaves the streak and any open incident untouched, so a target the
 * collector could not reach is left unknown rather than being marked
 * healthy (which would silently close a real incident) or down (which
 * would fabricate one).
 *
 * Skipping it is also what makes the coverage mark honest, and that is the
 * other half of this row. Every recorded check extends this target's observed
 * run; a tick that recorded nothing for it extends nothing, so a stretch the
 * collector could not observe shows up as a gap here rather than as an
 * unbroken run over hours nobody watched. `gap` is the same tolerance the
 * collector-wide mark uses, in seconds, and is a parameter only so a test can
 * span hours in two calls.
 *
 * Commits with the session, not on its own, so one host's whole container set
 * advances together instead of leaving half the containers with an advanced
 * streak when a round dies midway.
 */
export const record = ({
  connection,
  result,
  at,
  threshold = 2,
  gap = COVERAGE_GAP_SECONDS,
}: {
  connection: Connection
  result: CheckResult
  at: Date
  threshold?: number
  gap?: number
}): 'opened' | 'closed' | null => {
  const row = asRow(
    connection
      .prepare(
        'SELECT ok_run, fail_run, last_at, observed_since FROM check_streak WHERE target = ?',
      )
      .get(result.target),
  )
  const streak = row === null ? null : fields(row)
  const okRun = result.ok ? (streak?.number('ok_run') ?? 0) + 1 : 0
  const failRun = result.ok ? 0 : (streak?.number('fail_run') ?? 0) + 1

  // a check further than `gap` from the previous one (or before it, if the
  // clock stepped backwards) leaves time this target was not being checked,
  // so its run starts over here
  const observedSince =
    streak !== null && withinGap({ earlier: parseIso(streak.text('last_at')), later: at, gap })
      ? streak.text('observed_since')
      : isoformat(at)

  connection
    .prepare(
      'INSERT INTO check_streak (target, ok_run, fail_run, last_at, observed_since) ' +
        'VALUES (?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET ' +
        'ok_run = excluded.ok_run, fail_run = excluded.fail_run, ' +
        'last_at = excluded.last_at, observed_since = excluded.observed_since',
    )
    .run(result.target, okRun, failRun, isoformat(at), observedSince)

  const current = asRow(
    connection
      .prepare('SELECT id FROM incidents WHERE target = ? AND closed_at IS NULL')
      .get(result.target),
  )
  const currentId = current === null ? null : fields(current).number('id')

  // a target degrading from timeout to auth is still the same outage,
  // but the operator needs the reason it is failing for now, not the one
  // it opened with. An empty reason never overwrites a named one.
  if (!result.ok && currentId !== null && !!result.reason) {
    connection.prepare('UPDATE incidents SET reason = ? WHERE id = ?').run(result.reason, currentId)
  }

  if (failRun >= threshold && currentId === null) {
    connection
      .prepare('INSERT INTO incidents (target, reason, opened_at) VALUES (?, ?, ?)')
      .run(result.target, result.reason, isoformat(at))
    return 'opened'
  }

  if (okRun >= threshold && currentId !== null) {
    connection
      .prepare('UPDATE incidents SET closed_at = ? WHERE id = ?')
      .run(isoformat(at), currentId)
    return 'closed'
  }

  return null
}

const incident = (row: Row): Incident => {
  const columns = fields(row)
  const closedAt = columns.textOrNull('closed_at')
  return {
    id: columns.number('id'),
    target: columns.text('target'),
    reason: columns.text('reason'),
    opened_at: parseIso(columns.text('opened_at')),
    closed_at: closedAt ? parseIso(closedAt) : null,
  }
}

const select = ({
  connection,
  sql,
  params,
}: {
  connection: Connection
  sql: string
  params: readonly string[]
}): readonly Incident[] => asRows(connection.prepare(sql).all(...params)).map(incident)

const COLUMNS = 'id, target, reason, opened_at, closed_at'

export const openIncidents = (connection: Connection): readonly Incident[] =>
  select({
    connection,
    sql: `SELECT ${COLUMNS} FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC`,
    params: [],
  })

export const history = ({
  connection,
  since,
}: {
  connection: Connection
  since: Date
}): readonly Incident[] =>
  select({
    connection,
    sql: `SELECT ${COLUMNS} FROM incidents WHERE opened_at >= ? ORDER BY opened_at DESC`,
    params: [isoformat(since)],
  })

/** `str.removeprefix`: the text without `prefix`, or unchanged when it does not start with it. */
const removePrefix = ({ text, prefix }: { text: string; prefix: string }): string =>
  text.startsWith(prefix) ? text.slice(prefix.length) : text

/**
 * Close open incidents under `prefix` whose suffix is no longer present.
 *
 * Targets are discovered, not declared: a stack gains Jellyfin, loses an app,
 * or renames one. Without this, a container removed while down keeps an
 * incident open forever and drags its uptime toward zero.
 *
 * The prefix is per host on purpose. Both vermithor and meleys run a
 * container named sonarr, so retiring one host's set must never reach into
 * the other's.
 */
export const retireAbsent = ({
  connection,
  prefix,
  seen,
  at,
}: {
  connection: Connection
  prefix: string
  seen: Iterable<string>
  at: Date
}): number => {
  const present: ReadonlySet<string> = new Set(seen)
  const stale = asRows(
    connection
      .prepare("SELECT id, target FROM incidents WHERE closed_at IS NULL AND target LIKE ? || '%'")
      .all(prefix),
  )
    .map((row) => ({ id: fields(row).number('id'), target: fields(row).text('target') }))
    .filter(({ target }) => !present.has(removePrefix({ text: target, prefix })))
  const close = connection.prepare(
    "UPDATE incidents SET closed_at = ?, reason = 'removed' WHERE id = ?",
  )
  stale.forEach(({ id }) => close.run(isoformat(at), id))
  // drop the streak too, so a container that comes back under the same
  // name starts clean rather than inheriting its old failure run
  const forget = connection.prepare('DELETE FROM check_streak WHERE target = ?')
  stale.forEach(({ target }) => forget.run(target))
  return stale.length
}

/**
 * This target's current unbroken run of recorded checks, or null when it
 * has never had one.
 *
 * Per target, not collector-wide, because those are different facts. A host
 * whose ssh cannot even be spawned records no check while the docker endpoint
 * beside it records one every tick: the round happened, that host was not
 * observed by it. A host that is merely down still records a failed check and
 * so keeps its run advancing, which is why per-target coverage does not go
 * Unknown for the host that is actually down, only for the one nothing
 * looked at.
 */
export const observedRun = ({
  connection,
  target,
}: {
  connection: Connection
  target: string
}): ObservedRun | null => {
  const row = asRow(
    connection
      .prepare('SELECT observed_since, last_at FROM check_streak WHERE target = ?')
      .get(target),
  )
  if (row === null) {
    return null
  }
  return {
    since: parseIso(fields(row).text('observed_since')),
    until: parseIso(fields(row).text('last_at')),
  }
}

/**
 * Percentage of the window the target was not inside an open incident, or
 * null when the target was not watched for the whole window.
 *
 * An incident still open at `now` counts as down through `now`; one that
 * opened before the window is clipped to the window start.
 *
 * `observed` is required for the reason this whole module exists:
 * availability computed from incident rows alone knows nothing about whether
 * anyone was watching. A collector down for 23 of 24 hours leaves no incident
 * rows for those 23 hours, and the window would score a flawless 100% for a
 * day in which nothing was observed. So both ends of the run have to cover
 * the window: one that started after `since` leaves the front unwatched, and
 * one whose last check is further back than `gap` seconds leaves the tail
 * unwatched, which is exactly the shape of a collector that can no longer
 * reach this target while still ticking. Unknown is the honest answer for
 * both.
 */
export const uptimePercent = ({
  connection,
  target,
  since,
  now,
  observed,
  gap = COVERAGE_GAP_SECONDS,
}: {
  connection: Connection
  target: string
  since: Date
  now: Date
  observed: ObservedRun
  gap?: number
}): number | null => {
  const window = secondsBetween({ from: since, to: now })
  const watchedToTheEnd = withinGap({ earlier: observed.until, later: now, gap })
  if (window <= 0 || observed.since.getTime() > since.getTime() || !watchedToTheEnd) {
    return null
  }

  const outages = select({
    connection,
    sql:
      `SELECT ${COLUMNS} FROM incidents ` +
      'WHERE target = ? AND (closed_at IS NULL OR closed_at >= ?)',
    params: [target, isoformat(since)],
  })
  // each outage clipped to the window, in milliseconds; the division is
  // secondsBetween on the clipped ends
  const down = outages.reduce((total, outage) => {
    const end = Math.min((outage.closed_at ?? now).getTime(), now.getTime())
    const start = Math.max(outage.opened_at.getTime(), since.getTime())
    return end > start ? total + (end - start) / 1000 : total
  }, 0)
  return pythonRound({ value: Math.max(0, (window - down) / window) * 100, digits: 3 })
}
