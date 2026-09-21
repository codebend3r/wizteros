"""What nobody has finished: the unplayed set, its summary, and one page of
rows.

Its own dialect of the filters, because it narrows the library rather than
the ledger: a group is never-played when no member of it was played, and a
quality filter reads the item's own rank rather than a play's.
"""

import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fleet_monitor.plays import base
from fleet_monitor.probes.plex import QUALITY_RANK, Kind, Quality

NeverKind = Literal["movie", "show", "album"]


@dataclass(frozen=True, slots=True)
class NeverPlayedRow:
    key: str
    host: str
    kind: NeverKind
    title: str
    context: str | None
    year: int | None
    quality: Quality | None
    library: str | None
    added_at: datetime | None
    items: int
    thumb: str | None


@dataclass(frozen=True, slots=True)
class NeverQualityCount:
    quality: base.QualityFilter
    count: int


@dataclass(frozen=True, slots=True)
class NeverHostCount:
    host: str
    count: int


@dataclass(frozen=True, slots=True)
class NeverPlayedSummary:
    movies: int
    shows: int
    albums: int
    by_quality: tuple[NeverQualityCount, ...]
    by_host: tuple[NeverHostCount, ...]


@dataclass(frozen=True, slots=True)
class NeverPlayedPage:
    summary: NeverPlayedSummary
    total: int
    page: int
    page_size: int
    rows: tuple[NeverPlayedRow, ...]


_NEVER_KIND: dict[Kind, NeverKind] = {"movie": "movie", "episode": "show", "track": "album"}

# Everything in the library nobody has finished inside the window, grouped
# the way the ranked views group: a film is itself, a show is one row however
# many episodes it has, an album likewise. A show or album with one played
# episode or track is not never-played, so the group is kept only when none
# of its members was.
_UNPLAYED_CTE = f"""
WITH played AS (
    SELECT DISTINCT host, rating_key FROM plex_plays {{played_where}}
),
candidates AS (
    SELECT i.host, i.rating_key, i.kind, i.title, i.parent_rating_key, i.parent_title,
           i.grandparent_rating_key, i.grandparent_title, i.year, i.section_id, i.added_at,
           i.thumb,
           {base.rank_sql("i.quality")} AS quality_rank,
           (p.rating_key IS NOT NULL) AS played
    FROM plex_items i
    LEFT JOIN played p ON p.host = i.host AND p.rating_key = i.rating_key
    {{candidates_where}}
),
unplayed AS (
    SELECT host, 'movie' AS kind, host || ':movie:' || rating_key AS key, title,
           NULL AS context, year, quality_rank, section_id, added_at, 1 AS items, thumb
    FROM candidates
    WHERE kind = 'movie' AND played = 0
    UNION ALL
    SELECT host, 'show', host || ':show:' || grandparent_rating_key, MIN(grandparent_title),
           NULL, NULL, MAX(quality_rank), MIN(section_id), MAX(added_at), COUNT(*), MIN(thumb)
    FROM candidates
    WHERE kind = 'episode' AND grandparent_rating_key IS NOT NULL
    GROUP BY host, grandparent_rating_key
    HAVING SUM(played) = 0
    UNION ALL
    SELECT host, 'album', host || ':album:' || parent_rating_key, MIN(parent_title),
           MIN(grandparent_title), NULL, 0, MIN(section_id), MAX(added_at), COUNT(*), MIN(thumb)
    FROM candidates
    WHERE kind = 'track' AND parent_rating_key IS NOT NULL
    GROUP BY host, parent_rating_key
    HAVING SUM(played) = 0
)
"""


def never_played(
    connection: sqlite3.Connection,
    filters: base.Filters,
    *,
    hosts: Sequence[str],
    page: int,
    page_size: int,
    q: str,
    now: datetime,
) -> NeverPlayedPage:
    """What nobody has finished inside the window, newest addition first.

    The summary keeps the whole picture under the window, host and search
    while the rows narrow further by kind and quality, so a reader looking at
    4K films still sees how many shows and albums sit unwatched beside them.

    `now` is what separates a real addition date from an impossible one. Plex
    carries a few items stamped decades ahead (QI on meleys says 2098), and
    sorted newest first those sit at the top of the list forever, over every
    title actually added this week.
    """
    cte = _UNPLAYED_CTE.format(
        played_where=base.where("viewed_at >= ?" if filters.since is not None else ""),
        candidates_where=base.where(
            "i.present = 1", "i.host = ?" if filters.host is not None else ""
        ),
    )
    # in the order the two clauses appear above
    params = tuple(value for value in (filters.since, filters.host) if value is not None)

    # Materialised once per request. sqlite evaluates a CTE afresh in every
    # statement that names it, and this request makes five: over the fleet's
    # 177,000 items that was a second per read, and the page reads it on every
    # filter press. The temp table lives in this connection only, which the
    # session opened for this one request, and it is dropped on the way out
    # so a connection a test holds open stays clean.
    connection.execute("DROP TABLE IF EXISTS unplayed_now")
    connection.execute(f"CREATE TEMP TABLE unplayed_now AS {cte} SELECT * FROM unplayed", params)
    try:
        return _never_played_page(
            connection, filters, hosts=hosts, page=page, page_size=page_size, q=q, now=now
        )
    finally:
        connection.execute("DROP TABLE IF EXISTS unplayed_now")


def unplayed_conditions(filters: base.Filters) -> tuple[tuple[str, ...], tuple[object, ...]]:
    """The unplayed dialect of `base.conditions`: the same kind and quality
    narrowing, read off the library row's own rank rather than a play's item,
    and spoken in the three kinds this view groups by.

    Every clause names the alias, because the rows query joins the sections
    table, which has `kind` and `title` columns of its own, and a bare column
    name there is an ambiguity error rather than a filter.
    """
    kind_clauses = ("u.kind = ?",) if filters.kind is not None else ()
    kind_params: tuple[object, ...] = (
        (_NEVER_KIND[filters.kind],) if filters.kind is not None else ()
    )
    if filters.quality == "other":
        # unknown or sd video; an album has no video and is not "other"
        quality_clauses = (f"u.kind != 'album' AND u.quality_rank <= {base.OTHER_RANK_MAX}",)
        quality_params: tuple[object, ...] = ()
    elif filters.quality is not None:
        quality_clauses = ("u.kind != 'album' AND u.quality_rank = ?",)
        quality_params = (QUALITY_RANK[filters.quality],)
    else:
        quality_clauses = ()
        quality_params = ()
    return (*kind_clauses, *quality_clauses), (*kind_params, *quality_params)


def _never_played_page(
    connection: sqlite3.Connection,
    filters: base.Filters,
    *,
    hosts: Sequence[str],
    page: int,
    page_size: int,
    q: str,
    now: datetime,
) -> NeverPlayedPage:
    """The summary and one page of rows, read from the materialised set."""
    search_clause = ""
    search_params: tuple[object, ...] = ()
    if q.strip():
        # instr rather than LIKE, so a % or _ in the search is a character
        search_clause = "instr(lower(u.title), lower(?)) > 0"
        search_params = (q.strip(),)

    summary_where = base.where(search_clause)
    kinds = dict(
        connection.execute(
            f"SELECT u.kind, COUNT(*) FROM unplayed_now u {summary_where} GROUP BY u.kind",
            search_params,
        ).fetchall()
    )
    movie_where = base.where("u.kind = 'movie'", search_clause)
    by_quality = dict(
        connection.execute(
            f"""
            SELECT {base.filter_sql("u.quality_rank")} AS q, COUNT(*)
            FROM unplayed_now u {movie_where}
            GROUP BY q
            """,
            search_params,
        ).fetchall()
    )
    by_host = dict(
        connection.execute(
            f"SELECT u.host, COUNT(*) FROM unplayed_now u {summary_where} GROUP BY u.host",
            search_params,
        ).fetchall()
    )

    row_clauses, row_filters = unplayed_conditions(filters)
    row_where = base.where(search_clause, *row_clauses)
    row_params = (*search_params, *row_filters)

    total = connection.execute(
        f"SELECT COUNT(*) AS total FROM unplayed_now u {row_where}", row_params
    ).fetchone()["total"]
    rows = connection.execute(
        f"""
        SELECT u.*, s.title AS library
        FROM unplayed_now u
        LEFT JOIN plex_sections s ON s.host = u.host AND s.section_id = u.section_id
        {row_where}
        ORDER BY (u.added_at IS NULL OR u.added_at > ?), u.added_at DESC, u.title
        LIMIT ? OFFSET ?
        """,
        (*row_params, int(now.timestamp()), page_size, (page - 1) * page_size),
    ).fetchall()

    return NeverPlayedPage(
        summary=NeverPlayedSummary(
            movies=kinds.get("movie", 0),
            shows=kinds.get("show", 0),
            albums=kinds.get("album", 0),
            by_quality=tuple(
                NeverQualityCount(quality=quality, count=by_quality.get(quality, 0))
                for quality in base.QUALITY_FILTERS
            ),
            by_host=tuple(NeverHostCount(host=name, count=by_host.get(name, 0)) for name in hosts),
        ),
        total=total,
        page=page,
        page_size=page_size,
        rows=tuple(
            NeverPlayedRow(
                key=row["key"],
                host=row["host"],
                kind=row["kind"],
                title=row["title"],
                context=row["context"],
                year=row["year"],
                quality=base.quality(row["quality_rank"]),
                library=row["library"],
                added_at=base.utc_or_none(row["added_at"]),
                items=row["items"],
                thumb=row["thumb"],
            )
            for row in rows
        ),
    )
