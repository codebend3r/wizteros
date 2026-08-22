import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

# Samples are the raw tier: not a rollup, retained on their own clock, and aged
# by `at` rather than by `bucket`. Kept beside the rollups rather than inside
# them so pruning needs no per-table special case.
SAMPLE_RETENTION = timedelta(days=7)


@dataclass(frozen=True, slots=True)
class Resolution:
    """One rollup tier. Name, bucket width and retention travel together: they
    were three parallel dicts keyed by convention, so adding a tier meant
    remembering every one of them or silently getting a table that never
    pruned."""

    name: str
    seconds: int
    retention: timedelta

    @property
    def table(self) -> str:
        return f"rollup_{self.name}"


RESOLUTIONS = (
    Resolution(name="5m", seconds=300, retention=timedelta(days=90)),
    Resolution(name="1h", seconds=3600, retention=timedelta(days=730)),
)

_BY_NAME = {resolution.name: resolution for resolution in RESOLUTIONS}

_ROLLUP_SCHEMA = """
CREATE TABLE IF NOT EXISTS {table} (
    target     TEXT NOT NULL,
    metric     TEXT NOT NULL,
    bucket     TEXT NOT NULL,
    min_value  REAL NOT NULL,
    max_value  REAL NOT NULL,
    avg_value  REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (target, metric, bucket)
)
"""


def resolution(name: str) -> Resolution:
    """The named tier. Its `table` is interpolated into SQL, so going through
    this lookup is what keeps a caller's string off the query."""
    if name not in _BY_NAME:
        raise KeyError(name)
    return _BY_NAME[name]


def init_db(connection: sqlite3.Connection) -> None:
    for tier in RESOLUTIONS:
        connection.execute(_ROLLUP_SCHEMA.format(table=tier.table))


def bucket(at: datetime, seconds: int) -> datetime:
    """Floor a timestamp to its bucket start."""
    epoch = int(at.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % seconds), tz=timezone.utc)


def compact(connection: sqlite3.Connection, name: str, now: datetime) -> int:
    """Aggregate closed buckets into the rollup table.

    Scans only what is not already final. The upper bound skips the bucket
    containing `now`, because compacting it would freeze partial data that
    later samples would never correct. The lower bound is the newest bucket
    already written, which is the whole point: without it every run re-read and
    re-upserted the entire retention window, so a no-op compaction cost exactly
    as much as a real one and grew with the database (measured 0.20s at 74k
    rows, 1.63s at 446k, linear), every fifteen minutes, forever. That is also
    why the last written bucket is re-read rather than skipped: it is one
    bucket, and it absorbs any sample that landed after it was first rolled up.
    """
    tier = resolution(name)
    cutoff = bucket(now, tier.seconds).isoformat()
    newest = connection.execute(
        f"SELECT MAX(bucket) AS bucket FROM {tier.table}"
    ).fetchone()
    floor = (newest["bucket"] if newest else None) or ""
    cursor = connection.execute(
        f"""
        INSERT INTO {tier.table}
            (target, metric, bucket, min_value, max_value, avg_value, sample_count)
        SELECT target, metric,
               strftime('%Y-%m-%dT%H:%M:%S+00:00',
                        (CAST(strftime('%s', at) AS INTEGER) / {tier.seconds})
                        * {tier.seconds},
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
        """,
        (floor, cutoff),
    )
    return cursor.rowcount


def read(
    connection: sqlite3.Connection, name: str, target: str, metric: str
) -> tuple[tuple[datetime, float, float, float, int], ...]:
    """One metric's rollup rows at the given resolution, oldest first."""
    tier = resolution(name)
    rows = connection.execute(
        f"SELECT bucket, min_value, max_value, avg_value, sample_count "
        f"FROM {tier.table} WHERE target = ? AND metric = ? ORDER BY bucket",
        (target, metric),
    ).fetchall()
    return tuple(
        (
            datetime.fromisoformat(row["bucket"]),
            row["min_value"],
            row["max_value"],
            row["avg_value"],
            row["sample_count"],
        )
        for row in rows
    )


def prune(connection: sqlite3.Connection, now: datetime) -> dict[str, int]:
    """Drop rows past their retention window."""
    return {
        "samples": connection.execute(
            "DELETE FROM samples WHERE at < ?",
            ((now - SAMPLE_RETENTION).isoformat(),),
        ).rowcount,
        **{
            tier.table: connection.execute(
                f"DELETE FROM {tier.table} WHERE bucket < ?",
                ((now - tier.retention).isoformat(),),
            ).rowcount
            for tier in RESOLUTIONS
        },
    }
