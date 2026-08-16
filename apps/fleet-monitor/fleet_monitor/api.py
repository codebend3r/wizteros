from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Query

from fleet_monitor import config, incidents, rollups, store


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Create every table this process reads before it serves a request.

    sqlite3.connect() happily creates an empty file, so without this a fresh
    FM_DB_PATH turns the first /health into an unhandled 500 on a missing
    table. Every init_db is idempotent and order-independent, and the API and
    the collector may each be the first to run against a new volume, so both
    call all three.
    """
    db = config.db_path()
    store.init_db(db)
    rollups.init_db(db)
    incidents.init_db(db)
    yield


app = FastAPI(title="fleet-monitor", lifespan=lifespan)

# Three missed vitals ticks. Past this the dashboard is showing history, not
# the present, and must say so. This is collector liveness only - it says
# nothing about whether any given metric was recently observed.
STALE_AFTER = config.VITALS_INTERVAL * 3

# Three missed slow-tier ticks (disk, temperatures - collected every
# SLOW_INTERVAL, not every VITALS_INTERVAL). A metric older than this has
# outlived even its slowest expected refresh, not just an unlucky round.
METRICS_STALE_AFTER = config.SLOW_INTERVAL * 3

# A metric nothing has produced for a day is a source that went away - a veth
# renamed by a container restart, a hwmon chip that disappeared - not a late
# reading. Counting it forever would pin `metrics_stale` true on a healthy
# host. Deliberately far above METRICS_STALE_AFTER: everything between the two
# still reads as stale, which is the whole detection band.
METRIC_AGE_WINDOW = 24 * 3600

# Generous but bounded, well under what `timedelta` can represent. Without a
# cap, an absurd `hours` value overflows the C int `timedelta` builds from and
# turns into an unhandled 500 instead of a client error.
MAX_INCIDENT_HOURS = 24 * 365 * 5


def _age_seconds(*, now: datetime, at: datetime | None) -> float | None:
    """Seconds since `at`, or None when there is nothing to measure.

    A stamp in the future is None rather than a negative number. A clock that
    stepped backwards leaves rows the comparisons then read as newer than now,
    and a negative age would clear every staleness threshold: the page would
    show frozen values and affirmatively call them fresh. Unknown is the only
    honest answer.
    """
    if at is None:
        return None
    age = (now - at).total_seconds()
    return age if age >= 0 else None


def _heartbeat_status(now: datetime) -> tuple[datetime | None, float | None]:
    """The last recorded heartbeat and its age, or (None, None) when there has
    never been one."""
    last = store.last_heartbeat(config.db_path())
    return last, _age_seconds(now=now, at=last)


@app.get("/health")
def health() -> dict:
    """Liveness plus staleness.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. Staleness is how that blind spot surfaces instead of a frozen
    green dashboard.
    """
    _, age = _heartbeat_status(datetime.now(tz=timezone.utc))
    return {
        "ok": True,
        "heartbeat_age_seconds": age,
        "stale": age is None or age > STALE_AFTER,
    }


@app.get("/fleet")
def fleet() -> dict:
    """Every configured host's latest vitals, plus fleet-wide staleness.

    The top-level `stale` is heartbeat-derived, same as `/health`: it proves
    the collector process is alive, nothing about any individual metric. Each
    host additionally carries `metrics_stale` and `oldest_metric_age_seconds`,
    computed from the actual per-metric timestamps in `store`, so a host whose
    fast tier keeps the heartbeat fresh while its slow tier (disk,
    temperatures) has been failing silently is still caught: `collected` is
    true, the top-level `stale` is false, but `metrics_stale` is true because
    its oldest metric has outlived three slow-tier ticks.
    """
    db = config.db_path()
    now = datetime.now(tz=timezone.utc)
    last, age = _heartbeat_status(now)

    # read once for the whole fleet: it is a property of the collector, not of
    # any one host
    observed_since = store.coverage_since(db)
    hosts = [
        _host_status(db=db, host=host, now=now, observed_since=observed_since)
        for host in config.HOSTS
    ]
    return {
        "collected_at": last.isoformat() if last else None,
        "stale": age is None or age > STALE_AFTER,
        "hosts": hosts,
    }


def _host_status(
    *, db: str, host: config.Host, now: datetime, observed_since: datetime | None
) -> dict:
    target = f"host:{host.name}"
    metrics = store.latest(db, target)
    ages = store.metric_ages(db, target, since=now - timedelta(seconds=METRIC_AGE_WINDOW))
    oldest_age = _age_seconds(now=now, at=min(ages.values())) if ages else None
    return {
        "name": host.name,
        "ip": host.ip,
        "has_gpu": host.has_gpu,
        "has_docker": bool(host.docker_url),
        "collected": bool(metrics),
        "metrics": metrics,
        "oldest_metric_age_seconds": oldest_age,
        "metrics_stale": oldest_age is None or oldest_age > METRICS_STALE_AFTER,
        # a host never checked at all is unknown, not a perfect score - an
        # empty incident history must not read as proven uptime. Neither must
        # hours the collector itself was not running for: uptime_percent
        # returns None when the window starts before its current run did.
        "uptime_percent_24h": (
            incidents.uptime_percent(
                db,
                target,
                since=now - timedelta(hours=24),
                now=now,
                observed_since=observed_since,
            )
            if metrics and observed_since is not None
            else None
        ),
    }


@app.get("/incidents")
def incident_feed(hours: int = Query(default=24, ge=1, le=MAX_INCIDENT_HOURS)) -> dict:
    db = config.db_path()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    return {
        "open": list(incidents.open_incidents(db)),
        "recent": list(incidents.history(db, since)),
    }
