from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from fleet_monitor.store import _conn

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
    target     TEXT PRIMARY KEY,
    ok_run     INTEGER NOT NULL DEFAULT 0,
    fail_run   INTEGER NOT NULL DEFAULT 0,
    last_at    TEXT NOT NULL
)
"""


@dataclass(frozen=True, slots=True)
class CheckResult:
    target: str
    ok: bool
    reason: str = ""


def init_db(path: str) -> None:
    with _conn(path) as connection:
        connection.execute(_INCIDENTS_SCHEMA)
        connection.execute(_STREAK_SCHEMA)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS ix_incidents_target ON incidents (target, opened_at)"
        )


def record(
    path: str, result: CheckResult, at: datetime, *, threshold: int = 2
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
    """
    with _conn(path) as connection:
        row = connection.execute(
            "SELECT ok_run, fail_run FROM check_streak WHERE target = ?", (result.target,)
        ).fetchone()
        ok_run = (row["ok_run"] if row else 0) + 1 if result.ok else 0
        fail_run = 0 if result.ok else (row["fail_run"] if row else 0) + 1

        connection.execute(
            "INSERT INTO check_streak (target, ok_run, fail_run, last_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET "
            "ok_run = excluded.ok_run, fail_run = excluded.fail_run, last_at = excluded.last_at",
            (result.target, ok_run, fail_run, at.isoformat()),
        )

        current = connection.execute(
            "SELECT id FROM incidents WHERE target = ? AND closed_at IS NULL",
            (result.target,),
        ).fetchone()

        if fail_run >= threshold and current is None:
            connection.execute(
                "INSERT INTO incidents (target, reason, opened_at) VALUES (?, ?, ?)",
                (result.target, result.reason, at.isoformat()),
            )
            return "opened"

        if ok_run >= threshold and current is not None:
            connection.execute(
                "UPDATE incidents SET closed_at = ? WHERE id = ?", (at.isoformat(), current["id"])
            )
            return "closed"

    return None


def _rows(path: str, sql: str, params: tuple) -> tuple[dict, ...]:
    with _conn(path) as connection:
        return tuple(dict(row) for row in connection.execute(sql, params).fetchall())


def open_incidents(path: str) -> tuple[dict, ...]:
    return _rows(
        path,
        "SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC",
        (),
    )


def history(path: str, since: datetime) -> tuple[dict, ...]:
    return _rows(
        path,
        "SELECT * FROM incidents WHERE opened_at >= ? ORDER BY opened_at DESC",
        (since.isoformat(),),
    )


def retire_absent(path: str, prefix: str, seen: Collection[str], at: datetime) -> int:
    """Close open incidents under `prefix` whose suffix is no longer present.

    Targets are discovered, not declared: a stack gains Jellyfin, loses an app,
    or renames one. Without this, a container removed while down keeps an
    incident open forever and drags its uptime toward zero.

    The prefix is per host on purpose. Both vermithor and meleys run a
    container named sonarr, so retiring one host's set must never reach into
    the other's.
    """
    present = frozenset(seen)
    with _conn(path) as connection:
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


def uptime_percent(path: str, target: str, since: datetime, now: datetime) -> float:
    """Percentage of the window the target was not inside an open incident.

    An incident still open at `now` counts as down through `now`; one that
    opened before the window is clipped to the window start.
    """
    window = (now - since).total_seconds()
    if window <= 0:
        return 100.0

    rows = _rows(
        path,
        "SELECT opened_at, closed_at FROM incidents "
        "WHERE target = ? AND (closed_at IS NULL OR closed_at >= ?)",
        (target, since.isoformat()),
    )
    down = sum(
        (min(closed, now) - max(opened, since)).total_seconds()
        for opened, closed in (
            (
                datetime.fromisoformat(row["opened_at"]),
                datetime.fromisoformat(row["closed_at"]) if row["closed_at"] else now,
            )
            for row in rows
        )
        if min(closed, now) > max(opened, since)
    )
    return round(max(0.0, (window - down) / window) * 100.0, 3)
