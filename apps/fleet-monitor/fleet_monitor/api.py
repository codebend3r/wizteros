import re
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from fleet_monitor import collector, config, db, incidents, store
from fleet_monitor.incidents import Incident
from fleet_monitor.probes.docker import ContainerView, from_samples


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Create every table this process reads before it serves a request.

    sqlite3.connect() happily creates an empty file, so without this a fresh
    FM_DB_PATH turns the first /health into an unhandled 500 on a missing
    table. The collector and the API may each be the first to run against a new
    volume, so both call the same idempotent setup.
    """
    collector.init_db(config.db_path())
    yield


app = FastAPI(title="fleet-monitor", lifespan=lifespan)

# The portal is served from a different origin than this API everywhere it
# runs (the Vite dev server locally, the deployed portal against
# vermithor:8010 on the LAN), so without these headers every browser discards
# the response and the /fleet page reads as down while the API is healthy.
# Any origin is fine: the API is read-only, LAN-only, and credential-free.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
)

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
#
# It bounds what is reported, not just what is aged. Samples live seven days,
# so past this window a reading is still on disk with no age the window can
# express, and reporting the value while dropping its age is how a week-old
# disk number came back beside a bare "Healthy". Both reads take this floor.
METRIC_AGE_WINDOW = 24 * 3600

# Generous but bounded, well under what `timedelta` can represent. Without a
# cap, an absurd `hours` value overflows the C int `timedelta` builds from and
# turns into an unhandled 500 instead of a client error.
MAX_INCIDENT_HOURS = 24 * 365 * 5

# When a host needs attention. These live here, beside the staleness bands they
# sit next to, rather than in the SPA: they are judgments about the fleet, and
# the browser is not where the fleet is known.
DISK_WARN_PERCENT = 90.0
LOAD_WARN_PER_CORE = 1.0

# The collector only ever runs `df -Pk /volume1`, so this is the one volume the
# monitor can report on. Which volume that is, and which keys carry memory, are
# facts about what the collector collects: they belong beside it rather than in
# a browser a wire away from the code that chose the names.
DISK_PERCENT_METRIC = "disk.volume1.used_percent"
DISK_TOTAL_METRIC = "disk.volume1.total_bytes"
MEMORY_TOTAL_METRIC = "mem.total_bytes"
MEMORY_AVAILABLE_METRIC = "mem.available_bytes"

# /proc/stat emits one row per cpu, so the core count is observed every tick
# rather than declared anywhere. `cpu.total` is the aggregate row and is named
# so it cannot match.
_CORE_METRIC = re.compile(r"^cpu\d+\.user$")

HostState = Literal["ok", "warn", "unknown"]


@dataclass(frozen=True, slots=True)
class HostView:
    """One host as the dashboard sees it.

    Carries the raw `metrics` map and the judgments drawn from it. The
    judgments are here rather than in the SPA because they need fleet
    knowledge: which volume is monitored, how many cores the box turned out to
    have, what counts as too full.
    """

    name: str
    ip: str
    has_gpu: bool
    has_docker: bool
    collected: bool
    status: HostState
    cores: int | None
    load_per_core: float | None
    memory_percent: float | None
    memory_total_bytes: float | None
    disk_percent: float | None
    disk_total_bytes: float | None
    containers: list[ContainerView]
    # the raw readings behind every field above, kept because this is a monitor
    # and the unreduced numbers are the thing being monitored
    metrics: dict[str, float]
    oldest_metric_age_seconds: float | None
    metrics_stale: bool
    uptime_percent_24h: float | None


@dataclass(frozen=True, slots=True)
class FleetView:
    collected_at: datetime | None
    stale: bool
    hosts: list[HostView]


@dataclass(frozen=True, slots=True)
class HealthView:
    ok: bool
    heartbeat_age_seconds: float | None
    stale: bool


@dataclass(frozen=True, slots=True)
class IncidentFeed:
    open: list[Incident]
    recent: list[Incident]


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


@app.get("/health")
def health() -> HealthView:
    """Liveness plus staleness.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. Staleness is how that blind spot surfaces instead of a frozen
    green dashboard.
    """
    now = datetime.now(tz=timezone.utc)
    with db.session(config.db_path()) as connection:
        age = _age_seconds(now=now, at=store.last_heartbeat(connection))
    return HealthView(ok=True, heartbeat_age_seconds=age, stale=age is None or age > STALE_AFTER)


@app.get("/fleet")
def fleet() -> FleetView:
    """Every configured host's latest vitals, plus fleet-wide staleness.

    The top-level `stale` is heartbeat-derived, same as `/health`: it proves
    the collector process is alive, nothing about any individual metric. Each
    host additionally carries `metrics_stale` and `oldest_metric_age_seconds`,
    computed from the actual per-metric timestamps in `store`, so a host whose
    fast tier keeps the heartbeat fresh while its slow tier (disk,
    temperatures) has been failing silently is still caught: `collected` is
    true, the top-level `stale` is false, but `metrics_stale` is true because
    its oldest metric has outlived three slow-tier ticks.

    That flag can only speak for readings inside METRIC_AGE_WINDOW. Past a day
    a metric is no longer late, it is gone, and `metrics` stops carrying it at
    the same moment `metric_ages` stops dating it - so the slow tier that died
    three days ago shows its disk reading as absent rather than as a current
    number nothing can date. A host whose every reading has aged out that way
    reports `collected` false, the same as one nothing has ever reached.

    The whole response is read through one session. It used to open three
    connections per host plus two, so answering for five hosts cost seventeen.
    """
    now = datetime.now(tz=timezone.utc)
    with db.session(config.db_path()) as connection:
        last = store.last_heartbeat(connection)
        # read once for the whole fleet: it is a property of the collector, not
        # of any one host
        observed_since = store.coverage_since(connection)
        hosts = [
            _host_view(
                connection=connection, host=host, now=now, observed_since=observed_since
            )
            for host in config.HOSTS
        ]
    age = _age_seconds(now=now, at=last)
    return FleetView(
        collected_at=last, stale=age is None or age > STALE_AFTER, hosts=hosts
    )


def _uptime_24h(
    *,
    connection: sqlite3.Connection,
    target: str,
    now: datetime,
    observed_since: datetime | None,
) -> float | None:
    """This target's 24h availability, or None when nobody watched the window.

    Two coverage facts have to hold, and they are not the same fact.
    `observed_since` is collector-wide and says a round happened at all; the
    per-target run says a round observed *this* target. A spawn failure - ssh
    missing from PATH, the process out of file descriptors - records no check
    for any host while the docker endpoints beside them keep recording one, so
    the collector-wide mark runs on unbroken and would score a flawless day
    over hours in which not one host was looked at.
    """
    run = incidents.observed_run(connection, target)
    if run is None or observed_since is None:
        return None
    return incidents.uptime_percent(
        connection,
        target,
        since=now - timedelta(hours=24),
        now=now,
        # the later of the two starts: neither mark may widen the other's claim
        observed=incidents.ObservedRun(
            since=max(run.since, observed_since), until=run.until
        ),
    )


def core_count(metrics: dict[str, float]) -> int | None:
    """How many cores this host turned out to have, or None before it reported.

    Counted from the per-cpu rows /proc/stat already sends rather than declared
    in config. A declared number is a second copy to keep in step with a fleet
    that is not uniform, and it goes silently wrong the day a box is replaced.
    """
    return sum(1 for metric in metrics if _CORE_METRIC.match(metric)) or None


def memory_used_percent(metrics: dict[str, float]) -> float | None:
    """Used memory as a percentage, or None when the host has not reported it.

    Available rather than free: free excludes reclaimable page cache, and on
    these boxes that reads as 95% used on an idle machine.
    """
    total = metrics.get(MEMORY_TOTAL_METRIC)
    available = metrics.get(MEMORY_AVAILABLE_METRIC)
    if total is None or available is None or total <= 0:
        return None
    return round((total - available) / total * 100.0)


def host_state(
    *, collected: bool, disk_percent: float | None, load_per_core: float | None
) -> HostState:
    """Whether a host needs attention.

    "not collected" is its own state; it must never render as healthy.
    """
    if not collected:
        return "unknown"
    over_disk = disk_percent is not None and disk_percent >= DISK_WARN_PERCENT
    over_load = load_per_core is not None and load_per_core >= LOAD_WARN_PER_CORE
    return "warn" if over_disk or over_load else "ok"


def _host_view(
    *,
    connection: sqlite3.Connection,
    host: config.Host,
    now: datetime,
    observed_since: datetime | None,
) -> HostView:
    target = f"host:{host.name}"
    # one floor, read once, for both: a value `metric_ages` cannot date is a
    # value `latest` must not report
    since = now - timedelta(seconds=METRIC_AGE_WINDOW)
    metrics = store.latest(connection, target, since=since)
    ages = store.metric_ages(connection, target, since=since)
    oldest_age = _age_seconds(now=now, at=min(ages.values())) if ages else None

    cores = core_count(metrics)
    load = metrics.get("load.1m")
    load_per_core = load / cores if load is not None and cores else None
    disk_percent = metrics.get(DISK_PERCENT_METRIC)

    return HostView(
        name=host.name,
        ip=host.ip,
        has_gpu=host.has_gpu,
        has_docker=bool(host.docker_url),
        collected=bool(metrics),
        status=host_state(
            collected=bool(metrics),
            disk_percent=disk_percent,
            load_per_core=load_per_core,
        ),
        cores=cores,
        load_per_core=load_per_core,
        memory_percent=memory_used_percent(metrics),
        memory_total_bytes=metrics.get(MEMORY_TOTAL_METRIC),
        disk_percent=disk_percent,
        disk_total_bytes=metrics.get(DISK_TOTAL_METRIC),
        containers=list(from_samples(metrics)),
        metrics=metrics,
        oldest_metric_age_seconds=oldest_age,
        metrics_stale=oldest_age is None or oldest_age > METRICS_STALE_AFTER,
        # a host never checked at all is unknown, not a perfect score - an
        # empty incident history must not read as proven uptime. Neither must
        # hours nothing observed this host for, whether because the collector
        # was not running or because it was running and could not see it.
        uptime_percent_24h=(
            _uptime_24h(
                connection=connection,
                target=target,
                now=now,
                observed_since=observed_since,
            )
            if metrics
            else None
        ),
    )


@app.get("/incidents")
def incident_feed(hours: int = Query(default=24, ge=1, le=MAX_INCIDENT_HOURS)) -> IncidentFeed:
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    with db.session(config.db_path()) as connection:
        return IncidentFeed(
            open=list(incidents.open_incidents(connection)),
            recent=list(incidents.history(connection, since)),
        )
