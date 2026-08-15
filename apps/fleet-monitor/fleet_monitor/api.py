from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Query

from fleet_monitor import config, incidents, store

app = FastAPI(title="fleet-monitor")

# Three missed vitals ticks. Past this the dashboard is showing history, not
# the present, and must say so. This is collector liveness only - it says
# nothing about whether any given metric was recently observed.
STALE_AFTER = config.VITALS_INTERVAL * 3

# Three missed slow-tier ticks (disk, temperatures - collected every
# SLOW_INTERVAL, not every VITALS_INTERVAL). A metric older than this has
# outlived even its slowest expected refresh, not just an unlucky round.
METRICS_STALE_AFTER = config.SLOW_INTERVAL * 3

# Generous but bounded, well under what `timedelta` can represent. Without a
# cap, an absurd `hours` value overflows the C int `timedelta` builds from and
# turns into an unhandled 500 instead of a client error.
MAX_INCIDENT_HOURS = 24 * 365 * 5


def _heartbeat_status(now: datetime) -> tuple[datetime | None, float | None]:
    """The last recorded heartbeat and its age, or (None, None) when there has
    never been one."""
    last = store.last_heartbeat(config.db_path())
    age = (now - last).total_seconds() if last else None
    return last, age


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

    hosts = [_host_status(db=db, host=host, now=now) for host in config.HOSTS]
    return {
        "collected_at": last.isoformat() if last else None,
        "stale": age is None or age > STALE_AFTER,
        "hosts": hosts,
    }


def _host_status(*, db: str, host: config.Host, now: datetime) -> dict:
    metrics = store.latest(db, f"host:{host.name}")
    ages = store.metric_ages(db, f"host:{host.name}")
    oldest_age = (now - min(ages.values())).total_seconds() if ages else None
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
        # empty incident history must not read as proven uptime
        "uptime_percent_24h": (
            incidents.uptime_percent(
                db, f"host:{host.name}", since=now - timedelta(hours=24), now=now
            )
            if metrics
            else None
        ),
    }


@app.get("/incidents")
def incident_feed(hours: int = Query(default=24, le=MAX_INCIDENT_HOURS)) -> dict:
    db = config.db_path()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    return {
        "open": list(incidents.open_incidents(db)),
        "recent": list(incidents.history(db, since)),
    }
