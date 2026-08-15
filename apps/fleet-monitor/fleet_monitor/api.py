from datetime import datetime, timedelta, timezone

from fastapi import FastAPI

from fleet_monitor import config, incidents, store

app = FastAPI(title="fleet-monitor")

# Three missed vitals ticks. Past this the dashboard is showing history, not
# the present, and must say so.
STALE_AFTER = config.VITALS_INTERVAL * 3


def _heartbeat_age(now: datetime) -> float | None:
    last = store.last_heartbeat(config.db_path())
    return (now - last).total_seconds() if last else None


@app.get("/health")
def health() -> dict:
    """Liveness plus staleness.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. Staleness is how that blind spot surfaces instead of a frozen
    green dashboard.
    """
    age = _heartbeat_age(datetime.now(tz=timezone.utc))
    return {
        "ok": True,
        "heartbeat_age_seconds": age,
        "stale": age is None or age > STALE_AFTER,
    }


@app.get("/fleet")
def fleet() -> dict:
    """Every configured host's latest vitals, plus fleet-wide staleness.

    A host's own `collected` flag only says whether its vitals tier has ever
    written a sample; `store.latest` carries no age, so a slow-tier metric
    (disk, temperatures) that stopped updating a week ago is still returned
    here as the newest value on record. The heartbeat-derived `stale` at the
    top of the response is the only signal that the whole snapshot might be
    old; it does not, and cannot, catch one metric going stale while others
    keep ticking.
    """
    db = config.db_path()
    now = datetime.now(tz=timezone.utc)
    last = store.last_heartbeat(db)
    age = (now - last).total_seconds() if last else None

    hosts = [_host_status(db=db, host=host, now=now) for host in config.HOSTS]
    return {
        "collected_at": last.isoformat() if last else None,
        "stale": age is None or age > STALE_AFTER,
        "hosts": hosts,
    }


def _host_status(*, db: str, host: config.Host, now: datetime) -> dict:
    metrics = store.latest(db, f"host:{host.name}")
    return {
        "name": host.name,
        "ip": host.ip,
        "has_gpu": host.has_gpu,
        "has_docker": bool(host.docker_url),
        "collected": bool(metrics),
        "metrics": metrics,
        "uptime_percent_24h": incidents.uptime_percent(
            db, f"host:{host.name}", since=now - timedelta(hours=24), now=now
        ),
    }


@app.get("/incidents")
def incident_feed(hours: int = 24) -> dict:
    db = config.db_path()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    return {
        "open": list(incidents.open_incidents(db)),
        "recent": list(incidents.history(db, since)),
    }
