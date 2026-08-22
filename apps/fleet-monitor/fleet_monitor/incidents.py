import sqlite3
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta

from fleet_monitor.store import COVERAGE_GAP

_INCIDENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS incidents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    target    TEXT NOT NULL,
    reason    TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    closed_at TEXT
)
"""

_STREAK_SCHEMA = """
CREATE TABLE IF NOT EXISTS check_streak (
    target         TEXT PRIMARY KEY,
    ok_run         INTEGER NOT NULL DEFAULT 0,
    fail_run       INTEGER NOT NULL DEFAULT 0,
    last_at        TEXT NOT NULL,
    observed_since TEXT NOT NULL
)
"""


@dataclass(frozen=True, slots=True)
class CheckResult:
    target: str
    ok: bool
    reason: str = ""


@dataclass(frozen=True, slots=True)
class Incident:
    """One outage, open when `closed_at` is None.

    A real type rather than the row dict `SELECT *` used to hand back. That
    made the table's shape the wire's shape, so renaming a column silently
    reshaped the public API and the only thing describing the contract was a
    hand-written type guard in the SPA.
    """

    id: int
    target: str
    reason: str
    opened_at: datetime
    closed_at: datetime | None


@dataclass(frozen=True, slots=True)
class ObservedRun:
    """The stretch of time one target was actually being checked.

    `since` is when its current unbroken run of recorded checks began, `until`
    is when the last one landed. Both halves are load-bearing: a run that began
    before a window but stopped inside it leaves the rest of that window
    unobserved, and scoring it would read the collector's silence as the target
    being up.
    """

    since: datetime
    until: datetime


def init_db(connection: sqlite3.Connection) -> None:
    """Create this module's tables, and carry an older check_streak forward.

    CREATE TABLE IF NOT EXISTS never widens an existing table, so a database
    written before observed_since existed would answer every check with "no
    such column". The backfill claims only what the old row proves: the last
    check it saw. That under-claims coverage - uptime reads Unknown until a
    fresh run has spanned the window - which is the safe direction to be wrong.
    """
    connection.execute(_INCIDENTS_SCHEMA)
    connection.execute(_STREAK_SCHEMA)
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(check_streak)")
    }
    if "observed_since" not in columns:
        connection.execute(
            "ALTER TABLE check_streak ADD COLUMN observed_since TEXT NOT NULL DEFAULT ''"
        )
        connection.execute("UPDATE check_streak SET observed_since = last_at")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_incidents_target ON incidents (target, opened_at)"
    )


def record(
    connection: sqlite3.Connection,
    result: CheckResult,
    at: datetime,
    *,
    threshold: int = 2,
    gap: timedelta = COVERAGE_GAP,
) -> str | None:
    """Fold one check into the streak, opening or closing an incident on the
    threshold. Returns "opened", "closed", or None.

    Hysteresis is deliberate. A single dropped packet is not an outage, and a
    monitor that fires on one gets ignored, which is worse than no monitor.

    This only ever sees an actual CheckResult: a probe that could not run at
    all (a transport failure, not a failed check) has nothing to hand here,
    and the caller must not synthesize one. Skipping the call for that tick
    leaves the streak and any open incident untouched, so a target the
    collector could not reach is left unknown rather than being marked
    healthy (which would silently close a real incident) or down (which
    would fabricate one).

    Skipping it is also what makes the coverage mark honest, and that is the
    other half of this row. Every recorded check extends this target's observed
    run; a tick that recorded nothing for it extends nothing, so a stretch the
    collector could not observe shows up as a gap here rather than as an
    unbroken run over hours nobody watched. `gap` is the same tolerance the
    collector-wide mark uses, and is a parameter only so a test can span hours
    in two calls.

    Commits with the session, not on its own, so one host's whole container set
    advances together instead of leaving half the containers with an advanced
    streak when a round dies midway.
    """
    row = connection.execute(
        "SELECT ok_run, fail_run, last_at, observed_since FROM check_streak "
        "WHERE target = ?",
        (result.target,),
    ).fetchone()
    ok_run = (row["ok_run"] if row else 0) + 1 if result.ok else 0
    fail_run = 0 if result.ok else (row["fail_run"] if row else 0) + 1

    previous_at = datetime.fromisoformat(row["last_at"]) if row else None
    # a check further than `gap` from the previous one - or before it, if
    # the clock stepped backwards - leaves time this target was not being
    # checked, so its run starts over here
    observed_since = (
        row["observed_since"]
        if previous_at is not None and timedelta(0) <= at - previous_at <= gap
        else at.isoformat()
    )

    connection.execute(
        "INSERT INTO check_streak (target, ok_run, fail_run, last_at, observed_since) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET "
        "ok_run = excluded.ok_run, fail_run = excluded.fail_run, "
        "last_at = excluded.last_at, observed_since = excluded.observed_since",
        (result.target, ok_run, fail_run, at.isoformat(), observed_since),
    )

    current = connection.execute(
        "SELECT id FROM incidents WHERE target = ? AND closed_at IS NULL",
        (result.target,),
    ).fetchone()

    # a target degrading from timeout to auth is still the same outage,
    # but the operator needs the reason it is failing for now, not the one
    # it opened with. An empty reason never overwrites a named one.
    if not result.ok and current is not None and result.reason:
        connection.execute(
            "UPDATE incidents SET reason = ? WHERE id = ?",
            (result.reason, current["id"]),
        )

    if fail_run >= threshold and current is None:
        connection.execute(
            "INSERT INTO incidents (target, reason, opened_at) VALUES (?, ?, ?)",
            (result.target, result.reason, at.isoformat()),
        )
        return "opened"

    if ok_run >= threshold and current is not None:
        connection.execute(
            "UPDATE incidents SET closed_at = ? WHERE id = ?",
            (at.isoformat(), current["id"]),
        )
        return "closed"

    return None


def _incident(row: sqlite3.Row) -> Incident:
    return Incident(
        id=row["id"],
        target=row["target"],
        reason=row["reason"],
        opened_at=datetime.fromisoformat(row["opened_at"]),
        closed_at=datetime.fromisoformat(row["closed_at"]) if row["closed_at"] else None,
    )


def _select(
    connection: sqlite3.Connection, sql: str, params: tuple
) -> tuple[Incident, ...]:
    return tuple(_incident(row) for row in connection.execute(sql, params).fetchall())


_COLUMNS = "id, target, reason, opened_at, closed_at"


def open_incidents(connection: sqlite3.Connection) -> tuple[Incident, ...]:
    return _select(
        connection,
        f"SELECT {_COLUMNS} FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC",
        (),
    )


def history(connection: sqlite3.Connection, since: datetime) -> tuple[Incident, ...]:
    return _select(
        connection,
        f"SELECT {_COLUMNS} FROM incidents WHERE opened_at >= ? ORDER BY opened_at DESC",
        (since.isoformat(),),
    )


def retire_absent(
    connection: sqlite3.Connection, prefix: str, seen: Collection[str], at: datetime
) -> int:
    """Close open incidents under `prefix` whose suffix is no longer present.

    Targets are discovered, not declared: a stack gains Jellyfin, loses an app,
    or renames one. Without this, a container removed while down keeps an
    incident open forever and drags its uptime toward zero.

    The prefix is per host on purpose. Both vermithor and meleys run a
    container named sonarr, so retiring one host's set must never reach into
    the other's.
    """
    present = frozenset(seen)
    stale = [
        (row["id"], row["target"])
        for row in connection.execute(
            "SELECT id, target FROM incidents "
            "WHERE closed_at IS NULL AND target LIKE ? || '%'",
            (prefix,),
        ).fetchall()
        if row["target"].removeprefix(prefix) not in present
    ]
    connection.executemany(
        "UPDATE incidents SET closed_at = ?, reason = 'removed' WHERE id = ?",
        [(at.isoformat(), incident_id) for incident_id, _ in stale],
    )
    # drop the streak too, so a container that comes back under the same
    # name starts clean rather than inheriting its old failure run
    connection.executemany(
        "DELETE FROM check_streak WHERE target = ?",
        [(target,) for _, target in stale],
    )
    return len(stale)


def observed_run(connection: sqlite3.Connection, target: str) -> ObservedRun | None:
    """This target's current unbroken run of recorded checks, or None when it
    has never had one.

    Per target, not collector-wide, because those are different facts. A host
    whose ssh cannot even be spawned records no check while the docker endpoint
    beside it records one every tick: the round happened, that host was not
    observed by it. A host that is merely down still records a failed check and
    so keeps its run advancing, which is why per-target coverage does not go
    Unknown for the host that is actually down - only for the one nothing
    looked at.
    """
    row = connection.execute(
        "SELECT observed_since, last_at FROM check_streak WHERE target = ?", (target,)
    ).fetchone()
    if row is None:
        return None
    return ObservedRun(
        since=datetime.fromisoformat(row["observed_since"]),
        until=datetime.fromisoformat(row["last_at"]),
    )


def uptime_percent(
    connection: sqlite3.Connection,
    target: str,
    since: datetime,
    now: datetime,
    *,
    observed: ObservedRun,
    gap: timedelta = COVERAGE_GAP,
) -> float | None:
    """Percentage of the window the target was not inside an open incident, or
    None when the target was not watched for the whole window.

    An incident still open at `now` counts as down through `now`; one that
    opened before the window is clipped to the window start.

    `observed` is required for the reason this whole module exists:
    availability computed from incident rows alone knows nothing about whether
    anyone was watching. A collector down for 23 of 24 hours leaves no incident
    rows for those 23 hours, and the window would score a flawless 100% for a
    day in which nothing was observed. So both ends of the run have to cover
    the window: one that started after `since` leaves the front unwatched, and
    one whose last check is further back than `gap` leaves the tail unwatched -
    which is exactly the shape of a collector that can no longer reach this
    target while still ticking. Unknown is the honest answer for both.
    """
    window = (now - since).total_seconds()
    watched_to_the_end = timedelta(0) <= now - observed.until <= gap
    if window <= 0 or observed.since > since or not watched_to_the_end:
        return None

    outages = _select(
        connection,
        f"SELECT {_COLUMNS} FROM incidents "
        "WHERE target = ? AND (closed_at IS NULL OR closed_at >= ?)",
        (target, since.isoformat()),
    )
    down = sum(
        (min(closed, now) - max(incident.opened_at, since)).total_seconds()
        for incident in outages
        for closed in (incident.closed_at or now,)
        if min(closed, now) > max(incident.opened_at, since)
    )
    return round(max(0.0, (window - down) / window) * 100.0, 3)
