import re
import sqlite3
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import Depends, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from fleet_monitor import collector, config, db, incidents, series, store
from fleet_monitor.auth import require_admin
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
# runs (the Vite dev server locally, Netlify in production), so without these
# headers every browser discards the response and the /fleet page reads as
# down while the API is healthy.
#
# Any origin is still fine, but for a different reason than before: the API is
# no longer LAN-only, so what protects it is the bearer on each read, not the
# network it sits on. An open origin list without credentialed requests lets
# any page ASK, and every gated route still answers 401 without a session.
#
# `allow_headers` is what makes that bearer reachable: sending Authorization
# cross-origin triggers a preflight, and a preflight that does not name the
# header ends the request before it is made.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["Authorization"],
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

# The history window every chart shares. The floor is one vitals tick past
# nothing (a counter-derived series yields no delta from a single reading, so
# anything shorter cannot answer); the ceiling is seven days, which is how long
# raw samples live before rollups.prune takes them, so asking for more could
# only ever answer with less. Windows past a few hours carry more ticks than a
# chart can draw, so the series is bucketed on the way out rather than the
# window being refused.
DEFAULT_HISTORY_MINUTES = 60
MAX_HISTORY_MINUTES = 7 * 24 * 60

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
# Read from the series module rather than restated here: the card and the
# memory chart must never disagree about which gauge means "used".
MEMORY_TOTAL_METRIC = series.MEMORY_TOTAL_METRIC
MEMORY_AVAILABLE_METRIC = series.MEMORY_AVAILABLE_METRIC

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
    # which family carries the age below, so the page can name what fell
    # silent instead of guessing at the cause
    stalest_family: str | None
    stalest_family_age_seconds: float | None
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


@dataclass(frozen=True, slots=True)
class MetricPoint:
    at: datetime
    value: float


@dataclass(frozen=True, slots=True)
class MetricHostSeries:
    name: str
    points: list[MetricPoint]


@dataclass(frozen=True, slots=True)
class MetricHistoryView:
    """One metric family's history for the whole fleet.

    `kind` and `unit` travel with the numbers because the chart that draws them
    is one component for all four: without the unit it cannot know whether 40
    means 40 percent of a fixed scale or 40 bytes a second on a scale it has to
    derive from the data.
    """

    kind: str
    unit: str
    window_minutes: int
    hosts: list[MetricHostSeries]


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


# A metric name is `family.instance.field` (`net.eth0.rx_bytes`,
# `disk.volume1.used_percent`, `container.sonarr.up`) or `family.field`
# (`load.1m`, `uptime.seconds`). The leading segment is the family: everything
# under it is one probe reading one kind of source, so it is the unit that
# falls silent together.
def _family(metric: str) -> str:
    return metric.split(".", 1)[0]


def _stalest_family(ages: Mapping[str, datetime]) -> tuple[str, datetime] | None:
    """The metric family that has gone longest without any reading at all.

    Freshest member wins inside a family, stalest family wins across them, and
    that asymmetry is the whole point. A plain `min` over every metric let one
    vanished source speak for the whole host: a VPN tunnel that existed on
    meleys for an hour left `net.tun1000.*` frozen, and because
    METRIC_AGE_WINDOW is a day while METRICS_STALE_AFTER is 45 minutes, those
    two dead counters reported the host stale for the next 23 hours while
    `net.eth0.*` beside them updated every 30 seconds.

    A source going away is not the same event as a probe going quiet, and only
    the second one is worth a banner. Every case the `min` was there to catch
    still reads as stale, because it takes the whole family down: df failing,
    the hwmon chip gone, the host unreachable.

    Skipping the vanished source at the parser is the better fix where the name
    is predictable - see `_SKIP_PREFIXES` - but that list can only name the
    patterns already met, and this holds for the ones it has not.
    """
    freshest = {
        family: max(at for metric, at in ages.items() if _family(metric) == family)
        for family in {_family(metric) for metric in ages}
    }
    if not freshest:
        return None
    return min(freshest.items(), key=lambda pair: pair[1])


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


@app.get("/fleet", dependencies=[Depends(require_admin)])
def fleet() -> FleetView:
    """Every configured host's latest vitals, plus fleet-wide staleness.

    The top-level `stale` is heartbeat-derived, same as `/health`: it proves
    the collector process is alive, nothing about any individual metric. Each
    host additionally carries `metrics_stale` and `stalest_family_age_seconds`,
    computed from the actual per-metric timestamps in `store`, so a host whose
    fast tier keeps the heartbeat fresh while its slow tier (disk,
    temperatures) has been failing silently is still caught: `collected` is
    true, the top-level `stale` is false, but `metrics_stale` is true because
    one of its metric families has outlived three slow-tier ticks.

    Families, not metrics: `stalest_family` names what fell silent, and a
    family counts as reporting while any single metric under it does. See
    `_stalest_family` for why one dead counter must not speak for a host.

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
    stalest = _stalest_family(ages)
    stalest_age = _age_seconds(now=now, at=stalest[1]) if stalest else None

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
        stalest_family=stalest[0] if stalest else None,
        stalest_family_age_seconds=stalest_age,
        metrics_stale=stalest_age is None or stalest_age > METRICS_STALE_AFTER,
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


def _history(kind: str, minutes: int) -> MetricHistoryView:
    """One metric family's history for every configured host.

    Hosts arrive in config.HOSTS order, the same order `/fleet` uses. The
    portal binds one color per host by array position - on the cards from
    `/fleet`, on the charts from here - so the responses must never disagree
    about position.

    A host with no readings in the window has an empty series, not zeros: the
    chart renders that host as a legend entry with no line, which is the honest
    rendering of "not observed". Three of the five boxes have no render node at
    all, so on the GPU chart that is the normal case rather than a fault.

    A window wide enough to hold more ticks than a chart can draw comes back
    bucketed - see series.downsample. Every host is bucketed against the same
    window, so the thinning cannot put two hosts on different time bases.
    """
    family = series.FAMILIES[kind]
    now = datetime.now(tz=timezone.utc)
    since = now - timedelta(minutes=minutes)
    with db.session(config.db_path()) as connection:
        hosts = [
            MetricHostSeries(
                name=host.name,
                points=[
                    MetricPoint(at=at, value=value)
                    for at, value in series.history(
                        connection,
                        family=family,
                        target=f"host:{host.name}",
                        since=since,
                        until=now,
                    )
                ],
            )
            for host in config.HOSTS
        ]
    return MetricHistoryView(
        kind=family.kind, unit=family.unit, window_minutes=minutes, hosts=hosts
    )


@app.get("/fleet/cpu", dependencies=[Depends(require_admin)])
def fleet_cpu(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> MetricHistoryView:
    """Aggregate CPU busy percent per host, derived from the jiffy counters."""
    return _history("cpu", minutes)


@app.get("/fleet/memory", dependencies=[Depends(require_admin)])
def fleet_memory(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> MetricHistoryView:
    """Used memory percent per host, judged against MemAvailable."""
    return _history("memory", minutes)


@app.get("/fleet/gpu", dependencies=[Depends(require_admin)])
def fleet_gpu(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> MetricHistoryView:
    """Intel iGPU frequency as a share of its ceiling, per host.

    A load proxy, not utilization: DSM exposes no true busy percentage. Only
    vermithor and vhagar have a render node, so the other three are empty here
    permanently rather than pending a fix.
    """
    return _history("gpu", minutes)


@app.get("/fleet/network", dependencies=[Depends(require_admin)])
def fleet_network(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> MetricHistoryView:
    """Total bytes per second per host, received plus sent, every NIC summed."""
    return _history("network", minutes)


@app.get("/incidents", dependencies=[Depends(require_admin)])
def incident_feed(hours: int = Query(default=24, ge=1, le=MAX_INCIDENT_HOURS)) -> IncidentFeed:
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    with db.session(config.db_path()) as connection:
        return IncidentFeed(
            open=list(incidents.open_incidents(connection)),
            recent=list(incidents.history(connection, since)),
        )
