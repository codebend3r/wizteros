from datetime import datetime, timedelta, timezone

from fleet_monitor.store import _conn

RESOLUTIONS = {"5m": 300, "1h": 3600}

RETENTION = {
    "samples": timedelta(days=7),
    "rollup_5m": timedelta(days=90),
    "rollup_1h": timedelta(days=730),
}

_ROLLUP_SCHEMA = """
CREATE TABLE IF NOT EXISTS rollup_{name} (
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


def init_db(path: str) -> None:
    with _conn(path) as connection:
        for name in RESOLUTIONS:
            connection.execute(_ROLLUP_SCHEMA.format(name=name))


def bucket(at: datetime, seconds: int) -> datetime:
    """Floor a timestamp to its bucket start."""
    epoch = int(at.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % seconds), tz=timezone.utc)


def compact(path: str, resolution: str, now: datetime) -> int:
    """Aggregate closed buckets into the rollup table.

    The bucket containing `now` is skipped: compacting it would freeze partial
    data that later samples would never correct.
    """
    seconds = RESOLUTIONS[resolution]
    cutoff = bucket(now, seconds).isoformat()
    with _conn(path) as connection:
        cursor = connection.execute(
            f"""
            INSERT INTO rollup_{resolution}
                (target, metric, bucket, min_value, max_value, avg_value, sample_count)
            SELECT target, metric,
                   strftime('%Y-%m-%dT%H:%M:%S+00:00',
                            (CAST(strftime('%s', at) AS INTEGER) / {seconds}) * {seconds},
                            'unixepoch') AS b,
                   MIN(value), MAX(value), AVG(value), COUNT(*)
            FROM samples
            WHERE at < ?
            GROUP BY target, metric, b
            ON CONFLICT(target, metric, bucket) DO UPDATE SET
                min_value = excluded.min_value,
                max_value = excluded.max_value,
                avg_value = excluded.avg_value,
                sample_count = excluded.sample_count
            """,
            (cutoff,),
        )
        return cursor.rowcount


def read(
    path: str, resolution: str, target: str, metric: str
) -> tuple[tuple[datetime, float, float, float, int], ...]:
    """One metric's rollup rows at the given resolution, oldest first.

    `resolution` names a table and so is interpolated rather than bound, which
    makes the membership check load-bearing rather than cosmetic: it is the
    only thing between a caller's string and the SQL.
    """
    if resolution not in RESOLUTIONS:
        raise KeyError(resolution)
    with _conn(path) as connection:
        rows = connection.execute(
            f"SELECT bucket, min_value, max_value, avg_value, sample_count "
            f"FROM rollup_{resolution} WHERE target = ? AND metric = ? ORDER BY bucket",
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


def prune(path: str, now: datetime) -> dict[str, int]:
    """Drop rows past their retention window, shortest retention first."""
    with _conn(path) as connection:
        return {
            table: connection.execute(
                f"DELETE FROM {table} WHERE {'at' if table == 'samples' else 'bucket'} < ?",
                ((now - window).isoformat(),),
            ).rowcount
            for table, window in RETENTION.items()
        }
