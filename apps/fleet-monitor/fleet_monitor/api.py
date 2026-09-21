from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from fleet_monitor import collector, config, db, incidents, plays, series, store
from fleet_monitor.auth import require_admin
from fleet_monitor.fleet import STALE_AFTER, FleetView, age_seconds, fleet_view
from fleet_monitor.incidents import Incident
from fleet_monitor.probes.plex import Kind


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


@dataclass(frozen=True, slots=True)
class HealthView:
    ok: bool
    heartbeat_age_seconds: float | None
    stale: bool


@dataclass(frozen=True, slots=True)
class IncidentFeed:
    open: list[Incident]
    recent: list[Incident]


@app.get("/health")
def health() -> HealthView:
    """Liveness plus staleness.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. Staleness is how that blind spot surfaces instead of a frozen
    green dashboard.
    """
    now = datetime.now(tz=timezone.utc)
    with db.session(config.db_path()) as connection:
        age = age_seconds(now=now, at=store.last_heartbeat(connection))
    return HealthView(ok=True, heartbeat_age_seconds=age, stale=age is None or age > STALE_AFTER)


@app.get("/fleet", dependencies=[Depends(require_admin)])
def fleet() -> FleetView:
    """Every configured host's latest vitals, plus fleet-wide staleness.

    One session for the whole response: it used to open three connections per
    host plus two, so answering for five hosts cost seventeen. What the flags
    on each host mean, and why staleness is judged per metric family, is
    `fleet.fleet_view`.
    """
    with db.session(config.db_path()) as connection:
        return fleet_view(connection, now=datetime.now(tz=timezone.utc))


def _history(kind: str, minutes: int) -> series.MetricHistoryView:
    """One metric family's history for the whole fleet, read through one
    session. What the numbers mean is `series.fleet_history`."""
    now = datetime.now(tz=timezone.utc)
    with db.session(config.db_path()) as connection:
        return series.fleet_history(connection, kind=kind, minutes=minutes, now=now)


@app.get("/fleet/cpu", dependencies=[Depends(require_admin)])
def fleet_cpu(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> series.MetricHistoryView:
    """Aggregate CPU busy percent per host, derived from the jiffy counters."""
    return _history("cpu", minutes)


@app.get("/fleet/memory", dependencies=[Depends(require_admin)])
def fleet_memory(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> series.MetricHistoryView:
    """Used memory percent per host, judged against MemAvailable."""
    return _history("memory", minutes)


@app.get("/fleet/gpu", dependencies=[Depends(require_admin)])
def fleet_gpu(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> series.MetricHistoryView:
    """Intel iGPU frequency as a share of its ceiling, per host.

    A load proxy, not utilization: DSM exposes no true busy percentage. Only
    vermithor and vhagar have a render node, so the other three are empty here
    permanently rather than pending a fix.
    """
    return _history("gpu", minutes)


@app.get("/fleet/network", dependencies=[Depends(require_admin)])
def fleet_network(
    minutes: int = Query(default=DEFAULT_HISTORY_MINUTES, ge=2, le=MAX_HISTORY_MINUTES),
) -> series.MetricHistoryView:
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


# --- play history -----------------------------------------------------------

# The query literals are the store's own (`probes.plex.Kind`,
# `plays.QualityFilter`, `plays.Metric`) rather than copies declared here: a
# copy that drifts turns a valid filter into a 422 the page cannot explain.

# A year by default, the same span the first backfill reaches; zero means all
# time. The ceiling is generous but bounded for the same reason as
# MAX_INCIDENT_HOURS: an absurd value has to be a client error, not a 500 from
# a timedelta that overflowed.
DEFAULT_PLAY_DAYS = 365
MAX_PLAY_DAYS = 365 * 10
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
DEFAULT_TOP_LIMIT = 25
MAX_TOP_LIMIT = 100
MAX_SEARCH_LENGTH = 200
# A group key is `kind:title:year` over titles the library holds, so a
# generous bound still refuses anything that cannot be one.
MAX_KEY_LENGTH = 500


@dataclass(frozen=True, slots=True)
class PlaysWindow:
    """The window an answer covers, echoed back so a response can never be
    mistaken for another filter's. `since` is None for all time."""

    days: int
    since: datetime | None
    host: str | None
    kind: str | None
    quality: str | None


@dataclass(frozen=True, slots=True)
class PlayQuery:
    """The four filters every play-history read takes, resolved once. `now` is
    read here so the window, the timeline bucket and every "ago" on the page
    are measured from the same instant."""

    days: int
    filters: plays.Filters
    now: datetime

    @property
    def window(self) -> PlaysWindow:
        since = self.filters.since
        return PlaysWindow(
            days=self.days,
            since=datetime.fromtimestamp(since, tz=timezone.utc) if since is not None else None,
            host=self.filters.host,
            kind=self.filters.kind,
            quality=self.filters.quality,
        )


# Every view below carries the store's tuples as tuples. FastAPI serializes a
# tuple as a JSON array, so copying each one into a list changed nothing on the
# wire and made a pass-through read like a transformation.
@dataclass(frozen=True, slots=True)
class PlaysOverviewView:
    """`plays.Overview` plus the window it answers for."""

    window: PlaysWindow
    totals: plays.Totals
    by_kind: tuple[plays.KindCount, ...]
    by_quality: tuple[plays.QualityCount, ...]
    by_host: tuple[plays.HostCount, ...]
    timeline: plays.Timeline
    top_viewers: tuple[plays.Viewer, ...]
    top_titles: tuple[plays.TopTitle, ...]


@dataclass(frozen=True, slots=True)
class PlayUsersView:
    users: tuple[plays.User, ...]


@dataclass(frozen=True, slots=True)
class TopTitlesView:
    """`metric` travels with the rows so the page cannot fill its rewatched
    table with the most played, silently and plausibly."""

    metric: plays.Metric
    titles: tuple[plays.TopTitle, ...]


@dataclass(frozen=True, slots=True)
class PlaySyncView:
    lookback_days: int
    servers: tuple[plays.ServerStatus, ...]


def play_query(
    days: int = Query(default=DEFAULT_PLAY_DAYS, ge=0, le=MAX_PLAY_DAYS),
    host: str | None = Query(default=None),
    kind: Kind | None = Query(default=None),
    quality: plays.QualityFilter | None = Query(default=None),
) -> PlayQuery:
    """The shared filters, validated. An unknown host is a client error: the
    fleet is known, and a typo must not silently answer for nobody."""
    if host is not None and host not in {plex.name for plex in config.plex_hosts()}:
        raise HTTPException(status_code=422, detail=f"unknown host {host!r}")
    now = datetime.now(tz=timezone.utc)
    since = None if days == 0 else int((now - timedelta(days=days)).timestamp())
    return PlayQuery(
        days=days,
        filters=plays.Filters(since=since, host=host, kind=kind, quality=quality),
        now=now,
    )


@app.get("/plays/overview", dependencies=[Depends(require_admin)])
def plays_overview(query: PlayQuery = Depends(play_query)) -> PlaysOverviewView:
    """Everything the overview panel draws, in one read.

    by_kind, by_quality and by_host are zero-filled: a bucket with no plays is
    a bucket at zero, not a bucket that vanished, and the host list keeps
    config order so position stays identity across every view.
    """
    names = tuple(plex.name for plex in config.plex_hosts())
    with db.session(config.db_path()) as connection:
        data = plays.overview(connection, query.filters, hosts=names, now=query.now)
    return PlaysOverviewView(
        window=query.window,
        totals=data.totals,
        by_kind=data.by_kind,
        by_quality=data.by_quality,
        by_host=data.by_host,
        timeline=data.timeline,
        top_viewers=data.top_viewers,
        top_titles=data.top_titles,
    )


@app.get("/plays/users", dependencies=[Depends(require_admin)])
def plays_users(query: PlayQuery = Depends(play_query)) -> PlayUsersView:
    """Every viewer with a completed play under the filters, most first."""
    with db.session(config.db_path()) as connection:
        return PlayUsersView(users=plays.users(connection, query.filters))


@app.get("/plays/users/{account_id}/history", dependencies=[Depends(require_admin)])
def plays_user_history(
    account_id: int,
    query: PlayQuery = Depends(play_query),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> plays.HistoryPage:
    """One viewer's plays, newest first, a page at a time. A viewer nobody
    has named is still answered for, under their account id."""
    with db.session(config.db_path()) as connection:
        return plays.user_history(
            connection, query.filters, account_id=account_id, page=page, page_size=page_size
        )


@app.get("/plays/title", dependencies=[Depends(require_admin)])
def plays_title_history(
    query: PlayQuery = Depends(play_query),
    key: str = Query(min_length=1, max_length=MAX_KEY_LENGTH),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
) -> plays.TitleHistoryPage:
    """Every completed play of one title, newest first, a page at a time.

    The key travels as a query parameter rather than a path segment because it
    carries the title itself, slashes and all. A key nothing answers to is an
    empty page: a link older than the library it names is stale, not wrong.
    """
    with db.session(config.db_path()) as connection:
        return plays.title_history(
            connection, query.filters, key=key, page=page, page_size=page_size
        )


@app.get("/plays/top", dependencies=[Depends(require_admin)])
def plays_top(
    query: PlayQuery = Depends(play_query),
    metric: plays.Metric = Query(default="plays"),
    limit: int = Query(default=DEFAULT_TOP_LIMIT, ge=1, le=MAX_TOP_LIMIT),
) -> TopTitlesView:
    """Titles ranked by completed plays, or by rewatches, grouped the way a
    viewer names them: a film, a show, an album."""
    with db.session(config.db_path()) as connection:
        titles = plays.top_titles(connection, query.filters, metric=metric, limit=limit)
    return TopTitlesView(metric=metric, titles=titles)


@app.get("/plays/never-played", dependencies=[Depends(require_admin)])
def plays_never_played(
    query: PlayQuery = Depends(play_query),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    q: str = Query(default="", max_length=MAX_SEARCH_LENGTH),
) -> plays.NeverPlayedPage:
    """What is in the libraries with no completed play inside the window,
    newest addition first. With days=0 that is never played at all, as far as
    the ledger goes."""
    with db.session(config.db_path()) as connection:
        return plays.never_played(
            connection,
            query.filters,
            hosts=tuple(plex.name for plex in config.plex_hosts()),
            page=page,
            page_size=page_size,
            q=q,
            now=query.now,
        )


@app.get("/plays/sync", dependencies=[Depends(require_admin)])
def plays_sync() -> PlaySyncView:
    """Where the ledger stands on every Plex host, whether or not a pass has
    ever reached it: a host with no row is listed unreachable and empty rather
    than left out, since absence from the page would read as absence from the
    fleet."""
    with db.session(config.db_path()) as connection:
        servers = plays.sync_status(connection, hosts=config.plex_hosts())
    return PlaySyncView(lookback_days=config.plex_lookback_days(), servers=servers)
