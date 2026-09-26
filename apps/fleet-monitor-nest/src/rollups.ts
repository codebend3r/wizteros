import type { Connection } from '@/db.js'
import { asRow, asRows, fields } from '@/rows.js'
import { addSeconds, epochSeconds, isoformat, parseIso } from '@/time.js'

const DAY_SECONDS = 86_400

// Samples are the raw tier: not a rollup, retained on their own clock, and aged
// by `at` rather than by `bucket`. Kept beside the rollups rather than inside
// them so pruning needs no per-table special case.
export const SAMPLE_RETENTION_SECONDS = 7 * DAY_SECONDS

/**
 * One rollup tier. Name, bucket width and retention travel together: they
 * were three parallel dicts keyed by convention, so adding a tier meant
 * remembering every one of them or silently getting a table that never
 * pruned.
 *
 * `seconds` is the bucket width and `retention` is in seconds too.
 */
export type Resolution = Readonly<{
  name: string
  seconds: number
  retention: number
  table: string
}>

/** A tier, with its `table` derived from its name as the Python property was. */
const defineResolution = ({
  name,
  seconds,
  retention,
}: {
  name: string
  seconds: number
  retention: number
}): Resolution => ({ name, seconds, retention, table: `rollup_${name}` })

export const RESOLUTIONS: readonly Resolution[] = [
  defineResolution({ name: '5m', seconds: 300, retention: 90 * DAY_SECONDS }),
  defineResolution({ name: '1h', seconds: 3600, retention: 730 * DAY_SECONDS }),
]

const BY_NAME: ReadonlyMap<string, Resolution> = new Map(
  RESOLUTIONS.map((resolution) => [resolution.name, resolution] as const),
)

const rollupSchema = (table: string): string => `
CREATE TABLE IF NOT EXISTS ${table} (
    target     TEXT NOT NULL,
    metric     TEXT NOT NULL,
    bucket     TEXT NOT NULL,
    min_value  REAL NOT NULL,
    max_value  REAL NOT NULL,
    avg_value  REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (target, metric, bucket)
)
`

/**
 * The named tier. Its `table` is interpolated into SQL, so going through
 * this lookup is what keeps a caller's string off the query.
 *
 * Python raised KeyError here; a RangeError is the nearest JS error for a
 * value outside the set a function accepts.
 */
export const resolution = (name: string): Resolution => {
  const found = BY_NAME.get(name)
  if (found === undefined) {
    throw new RangeError(name)
  }
  return found
}

export const initDb = (connection: Connection): void => {
  RESOLUTIONS.forEach((tier) => connection.prepare(rollupSchema(tier.table)).run())
}

/** Floor a timestamp to its bucket start. */
export const bucket = ({ at, seconds }: { at: Date; seconds: number }): Date => {
  const epoch = epochSeconds(at)
  return new Date((epoch - (epoch % seconds)) * 1000)
}

/**
 * Aggregate closed buckets into the rollup table.
 *
 * Scans only what is not already final. The upper bound skips the bucket
 * containing `now`, because compacting it would freeze partial data that
 * later samples would never correct. The lower bound is the newest bucket
 * already written, which is the whole point: without it every run re-read and
 * re-upserted the entire retention window, so a no-op compaction cost exactly
 * as much as a real one and grew with the database (measured 0.20s at 74k
 * rows, 1.63s at 446k, linear), every fifteen minutes, forever. That is also
 * why the last written bucket is re-read rather than skipped: it is one
 * bucket, and it absorbs any sample that landed after it was first rolled up.
 */
export const compact = ({
  connection,
  name,
  now,
}: {
  connection: Connection
  name: string
  now: Date
}): number => {
  const tier = resolution(name)
  const cutoff = isoformat(bucket({ at: now, seconds: tier.seconds }))
  const newest = asRow(connection.prepare(`SELECT MAX(bucket) AS bucket FROM ${tier.table}`).get())
  const floor = (newest ? fields(newest).textOrNull('bucket') : null) ?? ''
  const info = connection
    .prepare(
      `
        INSERT INTO ${tier.table}
            (target, metric, bucket, min_value, max_value, avg_value, sample_count)
        SELECT target, metric,
               strftime('%Y-%m-%dT%H:%M:%S+00:00',
                        (CAST(strftime('%s', at) AS INTEGER) / ${tier.seconds})
                        * ${tier.seconds},
                        'unixepoch') AS b,
               MIN(value), MAX(value), AVG(value), COUNT(*)
        FROM samples
        WHERE at >= ? AND at < ?
        GROUP BY target, metric, b
        ON CONFLICT(target, metric, bucket) DO UPDATE SET
            min_value = excluded.min_value,
            max_value = excluded.max_value,
            avg_value = excluded.avg_value,
            sample_count = excluded.sample_count
        `,
    )
    .run(floor, cutoff)
  return info.changes
}

/** One rollup row: bucket, min, max, avg and sample count. */
export type RollupRow = readonly [Date, number, number, number, number]

/** One metric's rollup rows at the given resolution, oldest first. */
export const read = ({
  connection,
  name,
  target,
  metric,
}: {
  connection: Connection
  name: string
  target: string
  metric: string
}): readonly RollupRow[] => {
  const tier = resolution(name)
  return asRows(
    connection
      .prepare(
        `SELECT bucket, min_value, max_value, avg_value, sample_count ` +
          `FROM ${tier.table} WHERE target = ? AND metric = ? ORDER BY bucket`,
      )
      .all(target, metric),
  ).map((row) => {
    const columns = fields(row)
    return [
      parseIso(columns.text('bucket')),
      columns.number('min_value'),
      columns.number('max_value'),
      columns.number('avg_value'),
      columns.number('sample_count'),
    ] as const
  })
}

/** Drop rows past their retention window. */
export const prune = ({
  connection,
  now,
}: {
  connection: Connection
  now: Date
}): Record<string, number> => ({
  samples: connection
    .prepare('DELETE FROM samples WHERE at < ?')
    .run(isoformat(addSeconds({ at: now, seconds: -SAMPLE_RETENTION_SECONDS }))).changes,
  ...Object.fromEntries(
    RESOLUTIONS.map(
      (tier) =>
        [
          tier.table,
          connection
            .prepare(`DELETE FROM ${tier.table} WHERE bucket < ?`)
            .run(isoformat(addSeconds({ at: now, seconds: -tier.retention }))).changes,
        ] as const,
    ),
  ),
})
