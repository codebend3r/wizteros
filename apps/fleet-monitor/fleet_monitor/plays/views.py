"""The aggregates the plays page draws: the overview, the ranked titles, the
viewers, and the two paged histories.

Each one narrows the ledger through `base` and shapes the rows into the
dataclasses the API serves.
"""

import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fleet_monitor.plays import base, ledger
from fleet_monitor.probes.plex import Kind, Quality

Metric = Literal["plays", "rewatches"]
Bucket = Literal["day", "week", "month"]

# Windows up to a month are drawn by day, up to half a year by week, and
# anything wider by month, so a year of history is twelve bars rather than
# three hundred and sixty five slivers.
_DAY_BUCKET_MAX_DAYS = 31
_WEEK_BUCKET_MAX_DAYS = 180
_TOP_COUNT = 5


@dataclass(frozen=True, slots=True)
class Totals:
    plays: int
    viewers: int
    titles: int
    watch_ms: int


@dataclass(frozen=True, slots=True)
class KindCount:
    kind: Kind
    plays: int


@dataclass(frozen=True, slots=True)
class QualityCount:
    quality: base.QualityFilter
    plays: int


@dataclass(frozen=True, slots=True)
class HostCount:
    host: str
    friendly_name: str | None
    plays: int


@dataclass(frozen=True, slots=True)
class TimelinePoint:
    start: str
    plays: int
    hosts: dict[str, int]


@dataclass(frozen=True, slots=True)
class Timeline:
    bucket: Bucket
    points: tuple[TimelinePoint, ...]


@dataclass(frozen=True, slots=True)
class Viewer:
    account_id: int
    name: str
    plays: int


@dataclass(frozen=True, slots=True)
class Rewatcher:
    account_id: int
    name: str
    plays: int


@dataclass(frozen=True, slots=True)
class TopTitle:
    key: str
    kind: Kind
    title: str
    context: str | None
    year: int | None
    quality: Quality | None
    plays: int
    viewers: int
    items: int
    rewatches: int
    top_rewatcher: Rewatcher | None
    last_viewed_at: datetime
    hosts: tuple[str, ...]
    thumb: str | None


@dataclass(frozen=True, slots=True)
class Overview:
    totals: Totals
    by_kind: tuple[KindCount, ...]
    by_quality: tuple[QualityCount, ...]
    by_host: tuple[HostCount, ...]
    timeline: Timeline
    top_viewers: tuple[Viewer, ...]
    top_titles: tuple[TopTitle, ...]


@dataclass(frozen=True, slots=True)
class User:
    account_id: int
    name: str
    thumb: str | None
    plays: int
    movies: int
    episodes: int
    tracks: int
    hosts: tuple[str, ...]
    last_viewed_at: datetime | None
    top_title: str | None


@dataclass(frozen=True, slots=True)
class HistoryRow:
    viewed_at: datetime
    host: str
    kind: Kind
    #: The group the play belongs to, so a row can link to that title's own
    #: history without the page having to rebuild the key from the columns.
    group_key: str
    title: str
    parent_title: str | None
    grandparent_title: str | None
    index: int | None
    parent_index: int | None
    year: int | None
    quality: Quality | None
    device: str | None
    library: str | None
    duration_ms: int | None


@dataclass(frozen=True, slots=True)
class HistoryPage:
    account_id: int
    name: str
    total: int
    page: int
    page_size: int
    rows: tuple[HistoryRow, ...]


@dataclass(frozen=True, slots=True)
class TitleHistoryRow:
    """One completion of one item under a title, named by who finished it.

    `title` is the item, not the group: the episode, the track, the film. The
    group's own name is on the page around it.
    """

    viewed_at: datetime
    host: str
    kind: Kind
    account_id: int
    viewer: str
    title: str
    index: int | None
    parent_index: int | None
    year: int | None
    quality: Quality | None
    device: str | None
    library: str | None
    duration_ms: int | None


@dataclass(frozen=True, slots=True)
class TitleHistoryPage:
    """Every completed play of one title, with the figures that scope them.

    `kind` and `title` are None and empty only for a key nothing in the ledger
    answers to, which is a stale link rather than an error. They are read
    outside the window when the window holds no play, so a narrowed filter
    leaves the page named rather than blank.
    """

    key: str
    kind: Kind | None
    title: str
    context: str | None
    year: int | None
    quality: Quality | None
    viewers: int
    items: int
    rewatches: int
    first_viewed_at: datetime | None
    last_viewed_at: datetime | None
    hosts: tuple[str, ...]
    total: int
    page: int
    page_size: int
    rows: tuple[TitleHistoryRow, ...]


def _bucket(*, since: int | None, now: datetime) -> Bucket:
    if since is None:
        return "month"
    days = (int(now.timestamp()) - since) / 86_400
    if days <= _DAY_BUCKET_MAX_DAYS:
        return "day"
    if days <= _WEEK_BUCKET_MAX_DAYS:
        return "week"
    return "month"


# Local dates, so a play at eleven at night lands on the day it was watched
# rather than the UTC day it spilled into. The container carries the NAS's TZ.
_BUCKET_SQL: dict[Bucket, str] = {
    "day": "date(viewed_at, 'unixepoch', 'localtime')",
    # back six days then forward to the next Monday, which is the Monday on or
    # before the play: 'weekday 1' alone would push a Monday a week ahead
    "week": "date(viewed_at, 'unixepoch', 'localtime', '-6 days', 'weekday 1')",
    "month": "strftime('%Y-%m-01', viewed_at, 'unixepoch', 'localtime')",
}


def top_titles(
    connection: sqlite3.Connection, filters: base.Filters, *, metric: Metric, limit: int
) -> tuple[TopTitle, ...]:
    """The most played, or most rewatched, groups under the filters.

    Ties fall to the more recently played, so a page sorted by plays does not
    reshuffle its equal rows between refreshes.
    """
    with base.base_table(connection, filters) as table:
        return _top_titles_from(connection, table, metric=metric, limit=limit)


def _top_titles_from(
    connection: sqlite3.Connection, table: str, *, metric: Metric, limit: int
) -> tuple[TopTitle, ...]:
    """The ranking itself, over a base table the caller already opened, so
    `overview` ranks from the same one it totals from."""
    only_rewatched = "WHERE r.rewatches > 0" if metric == "rewatches" else ""
    order = "r.rewatches DESC, g.plays DESC" if metric == "rewatches" else "g.plays DESC"
    rows = connection.execute(
        f"""
        WITH per_item AS (
            SELECT group_key, account_id, host, rating_key, COUNT(*) AS plays
            FROM {table}
            GROUP BY group_key, account_id, host, rating_key
        ),
        groups AS (
            SELECT group_key,
                   MIN(kind) AS kind,
                   MIN(group_title) AS title,
                   MIN(group_context) AS context,
                   MIN(group_year) AS year,
                   COUNT(*) AS plays,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT host || ':' || rating_key) AS items,
                   MAX(viewed_at) AS last_viewed_at,
                   MAX(quality_rank) AS quality_rank,
                   GROUP_CONCAT(DISTINCT host) AS hosts,
                   MAX(thumb) AS thumb
            FROM {table}
            GROUP BY group_key
        ),
        rewatches AS (
            SELECT group_key, SUM(plays - 1) AS rewatches FROM per_item GROUP BY group_key
        ),
        rewatcher AS (
            -- sqlite hands back the bare column from the row holding the max
            SELECT group_key, account_id, MAX(plays) AS plays FROM per_item GROUP BY group_key
        )
        SELECT g.*, r.rewatches, w.account_id AS rewatcher_id, w.plays AS rewatcher_plays
        FROM groups g
        JOIN rewatches r ON r.group_key = g.group_key
        JOIN rewatcher w ON w.group_key = g.group_key
        {only_rewatched}
        ORDER BY {order}, g.last_viewed_at DESC, g.title
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    names, _ = base.identities(connection)
    return tuple(
        TopTitle(
            key=row["group_key"],
            kind=row["kind"],
            title=row["title"],
            context=row["context"],
            year=row["year"],
            quality=base.quality(row["quality_rank"]),
            plays=row["plays"],
            viewers=row["viewers"],
            items=row["items"],
            rewatches=row["rewatches"],
            top_rewatcher=(
                Rewatcher(
                    account_id=row["rewatcher_id"],
                    name=base.name(names, row["rewatcher_id"]),
                    plays=row["rewatcher_plays"],
                )
                if row["rewatcher_plays"] > 1
                else None
            ),
            last_viewed_at=base.utc(row["last_viewed_at"]),
            hosts=base.hosts(row["hosts"]),
            thumb=row["thumb"],
        )
        for row in rows
    )


def overview(
    connection: sqlite3.Connection,
    filters: base.Filters,
    *,
    hosts: Sequence[str],
    now: datetime,
) -> Overview:
    """Everything the overview panel draws, in one read.

    `hosts` is the fleet in config order: by_host is zero-filled in that
    order because the portal binds one colour per position, the same binding
    the fleet page uses, and a host with no plays must keep its slot.
    """
    with base.base_table(connection, filters) as table:
        totals_row = connection.execute(
            f"""
            SELECT COUNT(*) AS plays,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT group_key) AS titles,
                   COALESCE(SUM(duration_ms), 0) AS watch_ms
            FROM {table}
            """
        ).fetchone()
        by_kind = dict(
            connection.execute(f"SELECT kind, COUNT(*) FROM {table} GROUP BY kind").fetchall()
        )
        by_quality = dict(
            connection.execute(
                f"""
                SELECT {base.filter_sql("quality_rank")} AS q, COUNT(*)
                FROM {table}
                WHERE kind != 'track'
                GROUP BY q
                """
            ).fetchall()
        )
        by_host = dict(
            connection.execute(f"SELECT host, COUNT(*) FROM {table} GROUP BY host").fetchall()
        )
        friendly = dict(
            connection.execute("SELECT host, friendly_name FROM plex_servers").fetchall()
        )

        since = (
            filters.since
            if filters.since is not None
            else ledger.earliest_play(connection, host=filters.host)
        )
        bucket = _bucket(since=since, now=now)
        points: dict[str, dict[str, int]] = {}
        for row in connection.execute(
            f"""
            SELECT {_BUCKET_SQL[bucket]} AS start, host, COUNT(*) AS plays
            FROM {table}
            GROUP BY start, host
            ORDER BY start, host
            """
        ):
            points.setdefault(row["start"], {})[row["host"]] = row["plays"]

        names, _ = base.identities(connection)
        viewers = connection.execute(
            f"""
            SELECT account_id, COUNT(*) AS plays
            FROM {table}
            GROUP BY account_id
            ORDER BY plays DESC, account_id
            LIMIT ?
            """,
            (_TOP_COUNT,),
        ).fetchall()

        return Overview(
            totals=Totals(
                plays=totals_row["plays"],
                viewers=totals_row["viewers"],
                titles=totals_row["titles"],
                watch_ms=totals_row["watch_ms"],
            ),
            by_kind=tuple(
                KindCount(kind=kind, plays=by_kind.get(kind, 0)) for kind in base.KIND_ORDER
            ),
            by_quality=tuple(
                QualityCount(quality=quality, plays=by_quality.get(quality, 0))
                for quality in base.QUALITY_FILTERS
            ),
            by_host=tuple(
                HostCount(host=host, friendly_name=friendly.get(host), plays=by_host.get(host, 0))
                for host in hosts
            ),
            timeline=Timeline(
                bucket=bucket,
                points=tuple(
                    TimelinePoint(start=start, plays=sum(per_host.values()), hosts=per_host)
                    for start, per_host in points.items()
                ),
            ),
            top_viewers=tuple(
                Viewer(
                    account_id=row["account_id"],
                    name=base.name(names, row["account_id"]),
                    plays=row["plays"],
                )
                for row in viewers
            ),
            top_titles=_top_titles_from(connection, table, metric="plays", limit=_TOP_COUNT),
        )


def users(connection: sqlite3.Connection, filters: base.Filters) -> tuple[User, ...]:
    """Every viewer with a play under the filters, most plays first."""
    with base.base_table(connection, filters) as table:
        rows = connection.execute(
            f"""
            SELECT account_id,
                   COUNT(*) AS plays,
                   SUM(kind = 'movie') AS movies,
                   SUM(kind = 'episode') AS episodes,
                   SUM(kind = 'track') AS tracks,
                   MAX(viewed_at) AS last_viewed_at,
                   GROUP_CONCAT(DISTINCT host) AS hosts
            FROM {table}
            GROUP BY account_id
            ORDER BY plays DESC, account_id
            """
        ).fetchall()
        # the group a viewer has played most, alphabetical on a tie so the
        # favourite does not flicker between refreshes
        favourites: dict[int, str] = {}
        for row in connection.execute(
            f"""
            SELECT account_id, group_title, COUNT(*) AS plays
            FROM {table}
            GROUP BY account_id, group_key
            ORDER BY account_id, plays DESC, group_title
            """
        ):
            favourites.setdefault(row["account_id"], row["group_title"])
    names, thumbs = base.identities(connection)
    return tuple(
        User(
            account_id=row["account_id"],
            name=base.name(names, row["account_id"]),
            thumb=thumbs.get(row["account_id"]),
            plays=row["plays"],
            movies=row["movies"],
            episodes=row["episodes"],
            tracks=row["tracks"],
            hosts=base.hosts(row["hosts"]),
            last_viewed_at=base.utc(row["last_viewed_at"]),
            top_title=favourites.get(row["account_id"]),
        )
        for row in rows
    )


# Every column either history draws, so the two read the same rows and each
# keeps the shape it puts on the wire.
_PAGE_COLUMNS = """
    b.viewed_at, b.host, b.kind, b.account_id, b.group_key, b.item_title AS title,
    b.parent_title, b.grandparent_title, b.item_index, b.parent_index, b.year,
    b.quality, b.duration_ms, d.name AS device, s.title AS library
"""


def _page_of_plays(
    connection: sqlite3.Connection,
    table: str,
    *,
    where: str = "",
    params: Sequence[object] = (),
    page: int,
    page_size: int,
) -> list[sqlite3.Row]:
    """One page of plays from an open base table, newest first, each named by
    the device that played it and the library it sits in."""
    return connection.execute(
        f"""
        SELECT {_PAGE_COLUMNS}
        FROM {table} b
        LEFT JOIN plex_devices d ON d.host = b.host AND d.device_id = b.device_id
        LEFT JOIN plex_sections s ON s.host = b.host AND s.section_id = b.section_id
        {where}
        ORDER BY b.viewed_at DESC, b.history_id DESC
        LIMIT ? OFFSET ?
        """,
        (*params, page_size, (page - 1) * page_size),
    ).fetchall()


def user_history(
    connection: sqlite3.Connection,
    filters: base.Filters,
    *,
    account_id: int,
    page: int,
    page_size: int,
) -> HistoryPage:
    """One viewer's plays, newest first, one page at a time."""
    with base.base_table(
        connection, filters, extra=("p.account_id = ?",), extra_params=(account_id,)
    ) as table:
        total = connection.execute(f"SELECT COUNT(*) AS total FROM {table}").fetchone()["total"]
        rows = _page_of_plays(connection, table, page=page, page_size=page_size)
    names, _ = base.identities(connection)
    return HistoryPage(
        account_id=account_id,
        name=base.name(names, account_id),
        total=total,
        page=page,
        page_size=page_size,
        rows=tuple(
            HistoryRow(
                viewed_at=base.utc(row["viewed_at"]),
                host=row["host"],
                kind=row["kind"],
                group_key=row["group_key"],
                title=row["title"],
                parent_title=row["parent_title"],
                grandparent_title=row["grandparent_title"],
                index=row["item_index"],
                parent_index=row["parent_index"],
                year=row["year"],
                quality=row["quality"],
                device=row["device"],
                library=row["library"],
                duration_ms=row["duration_ms"],
            )
            for row in rows
        ),
    )


# What names a group, read from its most recent play. Used on its own, with
# no window, so a title stays named under a filter that holds none of its
# plays: the page has only the key, and an unnamed heading would read as a
# title that had been deleted rather than one nobody watched this month.
_TITLE_IDENTITY_SQL = """
    SELECT kind, group_title, group_context, group_year, quality_rank
    FROM {table}
    WHERE group_key = ?
    ORDER BY viewed_at DESC, history_id DESC
    LIMIT 1
"""


def title_history(
    connection: sqlite3.Connection,
    filters: base.Filters,
    *,
    key: str,
    page: int,
    page_size: int,
) -> TitleHistoryPage:
    """Every completed play of one title, newest first, a page at a time.

    The key is a group key as `top_titles` and `user_history` hand it out: a
    film, a show, an album, or a single item whose metadata never arrived. An
    unknown key is an empty page rather than an error, because a link older
    than the library it names is a stale link, not a fault.
    """
    with base.base_table(connection, filters) as table:
        summary = connection.execute(
            f"""
            WITH scoped AS (SELECT * FROM {table} WHERE group_key = ?),
            per_item AS (
                SELECT account_id, host, rating_key, COUNT(*) AS plays
                FROM scoped
                GROUP BY account_id, host, rating_key
            )
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT account_id) AS viewers,
                   COUNT(DISTINCT host || ':' || rating_key) AS items,
                   MIN(viewed_at) AS first_viewed_at,
                   MAX(viewed_at) AS last_viewed_at,
                   MAX(quality_rank) AS quality_rank,
                   GROUP_CONCAT(DISTINCT host) AS hosts,
                   MIN(kind) AS kind,
                   MIN(group_title) AS title,
                   MIN(group_context) AS context,
                   MIN(group_year) AS year,
                   (SELECT COALESCE(SUM(plays - 1), 0) FROM per_item) AS rewatches
            FROM scoped
            """,
            (key,),
        ).fetchone()

        kind = summary["kind"]
        title = summary["title"]
        context = summary["context"]
        year = summary["year"]
        quality_rank = summary["quality_rank"]
        if kind is None:
            # nothing under the filters: name the title from the ledger at
            # large, under its own name so the window's table stands
            with base.base_table(connection, base.Filters(), table="base_all") as unfiltered:
                named = connection.execute(
                    _TITLE_IDENTITY_SQL.format(table=unfiltered), (key,)
                ).fetchone()
            if named is not None:
                kind = named["kind"]
                title = named["group_title"]
                context = named["group_context"]
                year = named["group_year"]
                quality_rank = named["quality_rank"]

        names, _ = base.identities(connection)
        rows = _page_of_plays(
            connection,
            table,
            where="WHERE b.group_key = ?",
            params=(key,),
            page=page,
            page_size=page_size,
        )

    return TitleHistoryPage(
        key=key,
        kind=kind,
        title=title or "",
        context=context,
        year=year,
        quality=base.quality(quality_rank),
        viewers=summary["viewers"],
        items=summary["items"],
        rewatches=summary["rewatches"],
        first_viewed_at=base.utc_or_none(summary["first_viewed_at"]),
        last_viewed_at=base.utc_or_none(summary["last_viewed_at"]),
        hosts=base.hosts(summary["hosts"]),
        total=summary["total"],
        page=page,
        page_size=page_size,
        rows=tuple(
            TitleHistoryRow(
                viewed_at=base.utc(row["viewed_at"]),
                host=row["host"],
                kind=row["kind"],
                account_id=row["account_id"],
                viewer=base.name(names, row["account_id"]),
                title=row["title"],
                index=row["item_index"],
                parent_index=row["parent_index"],
                year=row["year"],
                quality=row["quality"],
                device=row["device"],
                library=row["library"],
                duration_ms=row["duration_ms"],
            )
            for row in rows
        ),
    )
