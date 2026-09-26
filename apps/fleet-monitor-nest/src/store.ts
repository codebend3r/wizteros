import { MAX_ROUND_SECONDS, VITALS_INTERVAL } from '@/config.js'
import type { Connection } from '@/db.js'
import type { Sample } from '@/probes/types.js'
import { asRow, asRows, fields, type Row } from '@/rows.js'
import { isoformat, parseIso, secondsBetween } from '@/time.js'

const SAMPLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
    target TEXT NOT NULL,
    metric TEXT NOT NULL,
    at     TEXT NOT NULL,
    value  REAL NOT NULL,
    kind   TEXT NOT NULL
)
`

const SAMPLES_INDEX = `
CREATE INDEX IF NOT EXISTS ix_samples_lookup ON samples (target, metric, at)
`

const HEARTBEAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL
)
`

const COVERAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS coverage (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    started_at TEXT NOT NULL
)
`

// How far apart two rounds may start before the silence between them counts as
// unwatched. Measured start to start, which means a round's own duration is
// inside it: a slow round spends up to MAX_ROUND_SECONDS on ssh before the loop
// sleeps again, so consecutive stamps land further apart than the interval with
// the collector never having stopped.
//
// The tolerance is one worst-case slow round plus three missed intervals. It
// used to have to absorb compaction too, which was unbounded and ran on the
// event loop; that is fixed at the source now (rollups.compact scans only what
// is new, off the loop), so this covers what it says it covers.
export const COVERAGE_GAP_SECONDS = MAX_ROUND_SECONDS + VITALS_INTERVAL * 3

export const initDb = (connection: Connection): void => {
  connection.prepare(SAMPLES_SCHEMA).run()
  connection.prepare(SAMPLES_INDEX).run()
  connection.prepare(HEARTBEAT_SCHEMA).run()
  connection.prepare(COVERAGE_SCHEMA).run()
}

/**
 * Insert one tick's samples.
 *
 * Commits with the rest of the session, so a tick's samples and the check
 * derived from them land together or not at all.
 */
export const writeSamples = ({
  connection,
  target,
  at,
  samples,
}: {
  connection: Connection
  target: string
  at: Date
  samples: readonly Sample[]
}): number => {
  const stamp = isoformat(at)
  if (samples.length === 0) {
    return 0
  }
  const insert = connection.prepare(
    'INSERT INTO samples (target, metric, at, value, kind) VALUES (?, ?, ?, ?, ?)',
  )
  samples.forEach((sample) => insert.run(target, sample.metric, stamp, sample.value, sample.kind))
  return samples.length
}

/**
 * The newest value of every metric for one target, seen since `since`.
 *
 * `since` is required, and it is the same floor `metricAges` takes, because
 * the two must always describe the same set of metrics. Samples are retained
 * for seven days while the age window is a day, so an unfloored read returns
 * values nothing can date: a disk reading from a slow tier that died three
 * days ago came back as a current number with no age beside it and no
 * staleness flag, and the page printed a bare "Healthy" over it. A value that
 * cannot be dated is not shown at all.
 */
export const latest = ({
  connection,
  target,
  since,
}: {
  connection: Connection
  target: string
  since: Date
}): Record<string, number> => {
  const rows = asRows(
    connection
      .prepare(
        `
        SELECT metric, value FROM samples
        WHERE target = ? AND at >= ? AND at = (
            SELECT MAX(at) FROM samples AS inner
            WHERE inner.target = samples.target AND inner.metric = samples.metric
        )
        `,
      )
      .all(target, isoformat(since)),
  )
  return Object.fromEntries(
    rows.map((row) => [fields(row).text('metric'), fields(row).number('value')] as const),
  )
}

/**
 * The timestamp of the newest value of every metric seen since `since`.
 *
 * Companion to `latest`: same grouping, exposing the `MAX(at)` that query
 * computes internally and discards. Kept as a separate call rather than
 * widening `latest`'s return shape, since other callers depend on it
 * returning bare values.
 *
 * `since` is required, not optional. Without a floor a metric whose source
 * disappeared (a veth renamed by a container restart, a removed hwmon chip)
 * keeps its one and only timestamp forever and drags the oldest-metric age
 * with it, so a perfectly healthy host reads as permanently stale. Anything
 * that stopped being produced before `since` drops out instead.
 */
export const metricAges = ({
  connection,
  target,
  since,
}: {
  connection: Connection
  target: string
  since: Date
}): Record<string, Date> => {
  const rows = asRows(
    connection
      .prepare(
        'SELECT metric, MAX(at) AS at FROM samples ' +
          'WHERE target = ? AND at >= ? GROUP BY metric',
      )
      .all(target, isoformat(since)),
  )
  return Object.fromEntries(
    rows.map((row) => [fields(row).text('metric'), parseIso(fields(row).text('at'))] as const),
  )
}

export type Series = readonly (readonly [Date, number])[]

export const series = ({
  connection,
  target,
  metric,
  since,
}: {
  connection: Connection
  target: string
  metric: string
  since: Date
}): Series =>
  asRows(
    connection
      .prepare(
        'SELECT at, value FROM samples WHERE target = ? AND metric = ? AND at >= ? ORDER BY at',
      )
      .all(target, metric, isoformat(since)),
  ).map((row) => [parseIso(fields(row).text('at')), fields(row).number('value')] as const)

/**
 * Every requested metric's series for one target, in one query.
 *
 * Companion to `series` for callers that read a family of metrics together:
 * the cpu.total counters are eight metrics that only mean anything as a set,
 * and eight scans per host per request is the alternative. A metric with no
 * rows in the window is absent from the result rather than an empty series;
 * the two are indistinguishable to a caller and must stay that way.
 *
 * Only `?` placeholders are interpolated into the SQL, one per metric name;
 * the names themselves travel as parameters.
 */
export const metricSeries = ({
  connection,
  target,
  metrics,
  since,
}: {
  connection: Connection
  target: string
  metrics: readonly string[]
  since: Date
}): Record<string, Series> => {
  if (metrics.length === 0) {
    return {}
  }
  const placeholders = metrics.map(() => '?').join(', ')
  const rows = asRows(
    connection
      .prepare(
        'SELECT metric, at, value FROM samples ' +
          `WHERE target = ? AND metric IN (${placeholders}) AND at >= ? ` +
          'ORDER BY metric, at',
      )
      .all(target, ...metrics, isoformat(since)),
  )
  return grouped(rows)
}

/**
 * Rows of (metric, at, value) pivoted into one series per metric.
 *
 * A window can hold tens of thousands of rows, so each metric's points are
 * gathered into one list as the rows arrive rather than copied per row, which
 * would make the pivot quadratic in the window.
 */
const grouped = (rows: readonly Row[]): Record<string, Series> =>
  Object.fromEntries(
    rows.reduce((points, row) => {
      const read = fields(row)
      const metric = read.text('metric')
      const list = points.get(metric) ?? []
      list.push([parseIso(read.text('at')), read.number('value')])
      return points.set(metric, list)
    }, new Map<string, (readonly [Date, number])[]>()),
  )

/** The first string that sorts past every name starting with `prefix`. */
const above = (prefix: string): string => {
  // by code point, as Python's ord and chr are, rather than by UTF-16 unit
  const characters = Array.from(prefix)
  const last = characters.at(-1)?.codePointAt(0) ?? 0
  return characters.slice(0, -1).join('') + String.fromCodePoint(last + 1)
}

/**
 * Every metric under one name prefix, for one target, in one query.
 *
 * Companion to `metricSeries` for a family whose members are discovered
 * rather than declared. The network counters are one rx/tx pair per
 * interface, and which interfaces a box has is not knowable from here: meleys
 * carries three and vhagar two, and a NIC added tomorrow has to appear
 * without a code change.
 *
 * Matched by a range rather than `LIKE`. SQLite's LIKE is case-insensitive
 * for ASCII by default, so it cannot use the (target, metric, at) index and
 * would scan every sample the target ever wrote; a half-open range on the
 * same column reads the index directly.
 */
export const metricSeriesPrefix = ({
  connection,
  target,
  prefix,
  since,
}: {
  connection: Connection
  target: string
  prefix: string
  since: Date
}): Record<string, Series> => {
  if (!prefix) {
    return {}
  }
  const rows = asRows(
    connection
      .prepare(
        'SELECT metric, at, value FROM samples ' +
          'WHERE target = ? AND metric >= ? AND metric < ? AND at >= ? ' +
          'ORDER BY metric, at',
      )
      .all(target, prefix, above(prefix), isoformat(since)),
  )
  return grouped(rows)
}

/**
 * Per-second rate between two counter readings, or null when the pair is
 * unusable.
 *
 * Counters are stored raw and converted here rather than at write time, so a
 * reboot is detectable: the counter goes backwards, and that one delta is
 * dropped instead of being rendered as a spike.
 */
export const rate = ({
  previous,
  current,
}: {
  previous: readonly [Date, number]
  current: readonly [Date, number]
}): number | null => {
  const [previousAt, previousValue] = previous
  const [currentAt, currentValue] = current
  const elapsed = secondsBetween({ from: previousAt, to: currentAt })
  if (elapsed <= 0 || currentValue < previousValue) {
    return null
  }
  return (currentValue - previousValue) / elapsed
}

/** Convert a counter series into a rate series, dropping reset pairs. */
export const rateSeries = (points: Series): Series =>
  points.slice(1).flatMap((current, index) => {
    const value = rate({ previous: points[index], current })
    return value === null ? [] : [[current[0], value] as const]
  })

/**
 * Record that a collection round completed, and advance the coverage mark.
 *
 * The collector runs on a box it also monitors, so it cannot report that box
 * being down. The UI reads this to show staleness instead of a frozen green
 * dashboard.
 *
 * The coverage mark is the second half of that: it is when the current
 * unbroken run of rounds began. A round more than `gap` seconds after the
 * previous one (or before it, if the clock stepped backwards) means time went
 * unwatched, so the mark restarts and no window reaching back past it can be
 * scored as uptime. `gap` is a parameter only so a test can span hours in two
 * writes; the collector always uses the default.
 *
 * This mark is collector-wide and says only that a round happened. Whether
 * any one target was observed by that round is a separate fact, tracked per
 * target in `incidents.observedRun`.
 */
export const writeHeartbeat = ({
  connection,
  at,
  gap = COVERAGE_GAP_SECONDS,
}: {
  connection: Connection
  at: Date
  gap?: number
}): void => {
  const row = asRow(connection.prepare('SELECT at FROM heartbeat WHERE id = 1').get())
  const last = row ? parseIso(fields(row).text('at')) : null
  connection
    .prepare(
      'INSERT INTO heartbeat (id, at) VALUES (1, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET at = excluded.at',
    )
    .run(isoformat(at))
  const sinceLast = last === null ? null : secondsBetween({ from: last, to: at })
  if (sinceLast === null || !(0 <= sinceLast && sinceLast <= gap)) {
    connection
      .prepare(
        'INSERT INTO coverage (id, started_at) VALUES (1, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at',
      )
      .run(isoformat(at))
  }
}

export const lastHeartbeat = (connection: Connection): Date | null => {
  const row = asRow(connection.prepare('SELECT at FROM heartbeat WHERE id = 1').get())
  return row ? parseIso(fields(row).text('at')) : null
}

/**
 * When the collector's current unbroken run of rounds began, or null when it
 * has never completed one.
 */
export const coverageSince = (connection: Connection): Date | null => {
  const row = asRow(connection.prepare('SELECT started_at FROM coverage WHERE id = 1').get())
  return row ? parseIso(fields(row).text('started_at')) : null
}
