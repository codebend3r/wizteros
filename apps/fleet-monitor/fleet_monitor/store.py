import sqlite3
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from itertools import pairwise

from fleet_monitor import config
from fleet_monitor.probes.types import Sample

_SAMPLES_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    target TEXT NOT NULL,
    metric TEXT NOT NULL,
    at     TEXT NOT NULL,
    value  REAL NOT NULL,
    kind   TEXT NOT NULL
)
"""

_SAMPLES_INDEX = """
CREATE INDEX IF NOT EXISTS ix_samples_lookup ON samples (target, metric, at)
"""

_HEARTBEAT_SCHEMA = """
CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL
)
"""

_COVERAGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS coverage (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    started_at TEXT NOT NULL
)
"""

# Three missed rounds. Under that the collector was up and merely late; past
# it there are hours nobody watched, and coverage has to restart so nothing
# downstream reads that silence as a clean run.
COVERAGE_GAP = timedelta(seconds=config.VITALS_INTERVAL * 3)


def _conn(path: str) -> sqlite3.Connection:
    """Open the SQLite file in WAL mode so a read never blocks a tick's write."""
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def init_db(path: str) -> None:
    with _conn(path) as connection:
        connection.execute(_SAMPLES_SCHEMA)
        connection.execute(_SAMPLES_INDEX)
        connection.execute(_HEARTBEAT_SCHEMA)
        connection.execute(_COVERAGE_SCHEMA)


def write_samples(path: str, target: str, at: datetime, samples: Iterable[Sample]) -> int:
    """Insert one tick's samples in a single transaction.

    Batched on purpose: a crash mid-tick then loses that tick and nothing else.
    """
    stamp = at.isoformat()
    rows = [(target, s.metric, stamp, s.value, s.kind) for s in samples]
    if not rows:
        return 0
    with _conn(path) as connection:
        connection.executemany(
            "INSERT INTO samples (target, metric, at, value, kind) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


def latest(path: str, target: str) -> dict[str, float]:
    """The newest value of every metric for one target."""
    with _conn(path) as connection:
        rows = connection.execute(
            """
            SELECT metric, value FROM samples
            WHERE target = ? AND at = (
                SELECT MAX(at) FROM samples AS inner
                WHERE inner.target = samples.target AND inner.metric = samples.metric
            )
            """,
            (target,),
        ).fetchall()
    return {row["metric"]: row["value"] for row in rows}


def metric_ages(path: str, target: str, *, since: datetime) -> dict[str, datetime]:
    """The timestamp of the newest value of every metric seen since `since`.

    Companion to `latest`: same grouping, exposing the `MAX(at)` that query
    computes internally and discards. Kept as a separate call rather than
    widening `latest`'s return shape, since other callers depend on it
    returning bare values.

    `since` is required, not optional. Without a floor a metric whose source
    disappeared - a veth renamed by a container restart, a removed hwmon chip -
    keeps its one and only timestamp forever and drags the oldest-metric age
    with it, so a perfectly healthy host reads as permanently stale. Anything
    that stopped being produced before `since` drops out instead.
    """
    with _conn(path) as connection:
        rows = connection.execute(
            "SELECT metric, MAX(at) AS at FROM samples "
            "WHERE target = ? AND at >= ? GROUP BY metric",
            (target, since.isoformat()),
        ).fetchall()
    return {row["metric"]: datetime.fromisoformat(row["at"]) for row in rows}


def series(
    path: str, target: str, metric: str, since: datetime
) -> tuple[tuple[datetime, float], ...]:
    with _conn(path) as connection:
        rows = connection.execute(
            "SELECT at, value FROM samples "
            "WHERE target = ? AND metric = ? AND at >= ? ORDER BY at",
            (target, metric, since.isoformat()),
        ).fetchall()
    return tuple((datetime.fromisoformat(row["at"]), row["value"]) for row in rows)


def rate(
    previous: tuple[datetime, float], current: tuple[datetime, float]
) -> float | None:
    """Per-second rate between two counter readings, or None when the pair is
    unusable.

    Counters are stored raw and converted here rather than at write time, so a
    reboot is detectable: the counter goes backwards, and that one delta is
    dropped instead of being rendered as a spike.
    """
    (previous_at, previous_value), (current_at, current_value) = previous, current
    elapsed = (current_at - previous_at).total_seconds()
    if elapsed <= 0 or current_value < previous_value:
        return None
    return (current_value - previous_value) / elapsed


def rate_series(
    points: Sequence[tuple[datetime, float]],
) -> tuple[tuple[datetime, float], ...]:
    """Convert a counter series into a rate series, dropping reset pairs."""
    computed = (
        (current[0], rate(previous, current)) for previous, current in pairwise(points)
    )
    return tuple((at, value) for at, value in computed if value is not None)


def write_heartbeat(path: str, at: datetime, *, gap: timedelta = COVERAGE_GAP) -> None:
    """Record that a collection round completed, and advance the coverage mark.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. The UI reads this to show staleness instead of a frozen green
    dashboard.

    The coverage mark is the second half of that: it is when the current
    unbroken run of rounds began. A round more than `gap` after the previous
    one - or before it, if the clock stepped backwards - means hours went
    unwatched, so the mark restarts and no window reaching back past it can be
    scored as uptime. `gap` is a parameter only so a test can span hours in two
    writes; the collector always uses the default.
    """
    with _conn(path) as connection:
        row = connection.execute("SELECT at FROM heartbeat WHERE id = 1").fetchone()
        last = datetime.fromisoformat(row["at"]) if row else None
        connection.execute(
            "INSERT INTO heartbeat (id, at) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET at = excluded.at",
            (at.isoformat(),),
        )
        if last is None or not (timedelta(0) <= at - last <= gap):
            connection.execute(
                "INSERT INTO coverage (id, started_at) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at",
                (at.isoformat(),),
            )


def last_heartbeat(path: str) -> datetime | None:
    with _conn(path) as connection:
        row = connection.execute("SELECT at FROM heartbeat WHERE id = 1").fetchone()
    return datetime.fromisoformat(row["at"]) if row else None


def coverage_since(path: str) -> datetime | None:
    """When the collector's current unbroken run of rounds began, or None when
    it has never completed one."""
    with _conn(path) as connection:
        row = connection.execute("SELECT started_at FROM coverage WHERE id = 1").fetchone()
    return datetime.fromisoformat(row["started_at"]) if row else None
