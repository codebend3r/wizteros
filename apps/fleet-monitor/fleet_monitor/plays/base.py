"""What every play view is built from: the filters, the joined select the
aggregates read, and the small conversions their rows need.

`base_table` holds, for one request, the plays that request asked for, and
every aggregate reads it. The rest of this module is what builds that table
and what turns a stored column into the value a dataclass carries.
"""

import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from fleet_monitor.probes.plex import QUALITY_RANK, Kind, Quality

# The four buckets the page groups video by, in the order it lists them.
# `other` folds sd and unknown together: a play whose item was deleted since
# has no resolution on record, and inventing one would be worse than a fourth
# column.
QualityFilter = Literal["4k", "1080p", "720p", "other"]
QUALITY_FILTERS: tuple[QualityFilter, ...] = ("4k", "1080p", "720p", "other")
KIND_ORDER: tuple[Kind, ...] = ("movie", "episode", "track")


RANK_QUALITY: dict[int, Quality] = {rank: quality for quality, rank in QUALITY_RANK.items()}

# The buckets that name a quality, and the rank at or below which a row is
# "other" instead. Derived rather than written down: the probe's ladder is
# where a new tier is named, and a ladder and a hand-written CASE that
# disagree would put a play in a column the totals do not count it in.
NAMED_FILTERS: tuple[QualityFilter, ...] = tuple(
    quality for quality in QUALITY_FILTERS if quality != "other"
)
OTHER_RANK_MAX = min(QUALITY_RANK[quality] for quality in NAMED_FILTERS) - 1


def rank_sql(column: str) -> str:
    """How a stored quality label ranks, as SQL, so a group can take its best
    one. An unknown or absent label ranks below every named bucket."""
    whens = " ".join(f"WHEN '{label}' THEN {rank}" for label, rank in QUALITY_RANK.items())
    return f"CASE {column} {whens} ELSE 0 END"


def filter_sql(rank_column: str) -> str:
    """Which bucket a rank falls in, as SQL: the quality it names, or
    "other" for anything below the lowest named one."""
    whens = " ".join(f"WHEN {QUALITY_RANK[quality]} THEN '{quality}'" for quality in NAMED_FILTERS)
    return f"CASE {rank_column} {whens} ELSE 'other' END"


# The best title known for a play's item: the library's, then the ledger's
# own, then a placeholder. The ledger does record completions with a blank
# title (measured 2026-09-18: a hundred or so episodes across the fleet), and
# a blank must not become a group that ranks.
ITEM_TITLE_SQL = "COALESCE(NULLIF(i.title, ''), NULLIF(p.title, ''), 'Untitled')"

# Every play joined to what is known about its item.
#
# An episode whose show is not known, or a track whose album is not, groups as
# itself rather than under its own title. Before this every unknown "Episode
# 1" from every unknown show landed in one row called "Episode 1", which was
# the top title on the fleet the first time real data was read. An item stands
# alone until its metadata arrives, and it says so in its context.
BASE_SELECT = f"""
    SELECT p.host, p.history_id, p.rating_key, p.kind, p.account_id, p.device_id,
           p.section_id, p.viewed_at,
           {ITEM_TITLE_SQL} AS item_title,
           i.parent_title, i.grandparent_title, i.parent_index, i.item_index, i.year,
           i.quality, i.duration_ms, i.thumb,
           CASE p.kind
             WHEN 'movie' THEN
               CASE WHEN COALESCE(NULLIF(i.title, ''), NULLIF(p.title, '')) IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'movie:' || lower({ITEM_TITLE_SQL})
                                  || ':' || COALESCE(CAST(i.year AS TEXT), '')
               END
             WHEN 'episode' THEN
               CASE WHEN NULLIF(i.grandparent_title, '') IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'show:' || lower(i.grandparent_title)
               END
             ELSE
               CASE WHEN NULLIF(i.parent_title, '') IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'album:' || lower(i.parent_title)
                                  || ':' || lower(COALESCE(i.grandparent_title, ''))
               END
           END AS group_key,
           CASE p.kind
             WHEN 'movie' THEN {ITEM_TITLE_SQL}
             WHEN 'episode' THEN COALESCE(NULLIF(i.grandparent_title, ''), {ITEM_TITLE_SQL})
             ELSE COALESCE(NULLIF(i.parent_title, ''), {ITEM_TITLE_SQL})
           END AS group_title,
           CASE p.kind
             WHEN 'episode' THEN
               CASE WHEN NULLIF(i.grandparent_title, '') IS NULL THEN 'show not known' END
             WHEN 'track' THEN
               CASE WHEN NULLIF(i.parent_title, '') IS NULL THEN 'album not known'
                    ELSE i.grandparent_title END
           END AS group_context,
           CASE p.kind WHEN 'movie' THEN i.year END AS group_year,
           {rank_sql("i.quality")} AS quality_rank
    FROM (
        SELECT *,
               LAG(viewed_at) OVER (
                   PARTITION BY host, rating_key, account_id
                   ORDER BY viewed_at, history_id
               ) AS prev_viewed_at
        FROM plex_plays
    ) p
    LEFT JOIN plex_items i ON i.host = p.host AND i.rating_key = p.rating_key
"""

# A completion the same viewer logged against the same item on the same
# server, sooner after the previous one than the item runs for, is that
# previous viewing marked watched again, not a second viewing. The first row
# is the one kept: it is when the item became watched. An item whose runtime
# is not known (gone from the library, never described) keeps every row, since
# a guess would delete a play a viewer may really have made.
#
# The predecessor is the row before by time, kept or not, so a chain of
# markings inside one runtime collapses to its head. The one shape this
# misjudges is a real replay finished within a runtime of a dropped marking
# rather than of the kept head; it costs one rewatch and needs a viewer to
# restart an item the moment it ends.
ONE_VIEWING_SQL = (
    "(p.prev_viewed_at IS NULL OR i.duration_ms IS NULL "
    "OR (p.viewed_at - p.prev_viewed_at) * 1000 >= i.duration_ms)"
)


@dataclass(frozen=True, slots=True)
class Filters:
    """What every view narrows by. `since` is an inclusive epoch floor, or
    None for all time. A quality filter is a statement about video, so it
    excludes tracks whichever bucket it names."""

    since: int | None = None
    host: str | None = None
    kind: Kind | None = None
    quality: QualityFilter | None = None


def where(*clauses: str) -> str:
    """The WHERE line for however many clauses are live, empty ones dropped,
    and nothing at all when none of them is."""
    live = tuple(clause for clause in clauses if clause)
    return f"WHERE {' AND '.join(live)}" if live else ""


def conditions(filters: Filters) -> tuple[list[str], list[object]]:
    """The WHERE clauses one Filters value adds to the play/item join."""
    clauses: list[str] = []
    params: list[object] = []
    if filters.since is not None:
        clauses.append("p.viewed_at >= ?")
        params.append(filters.since)
    if filters.host is not None:
        clauses.append("p.host = ?")
        params.append(filters.host)
    if filters.kind is not None:
        clauses.append("p.kind = ?")
        params.append(filters.kind)
    if filters.quality == "other":
        # sd and unknown video; a track has no video and is never "other"
        clauses.append(f"p.kind != 'track' AND {rank_sql('i.quality')} <= {OTHER_RANK_MAX}")
    elif filters.quality is not None:
        clauses.append("i.quality = ?")
        params.append(filters.quality)
    return clauses, params


@contextmanager
def base_table(
    connection: sqlite3.Connection,
    filters: Filters,
    *,
    extra: Sequence[str] = (),
    extra_params: Sequence[object] = (),
    table: str = "base_now",
) -> Iterator[str]:
    """Hold, for the life of the block, the plays a request asked for: each
    play joined to its item, narrowed by the filters, with a viewing Plex
    logged twice counted once. Yields the table's name.

    A table rather than a CTE because sqlite evaluates a CTE afresh in every
    statement that names it, and a view makes five or six. The base runs a
    LAG() window over the whole ledger, so naming it six times ran the window
    six times, and the page reads it on every filter press. The table lives in
    this connection only, which the session opened for this one request, and
    it is dropped on the way out so a connection a test holds open stays
    clean. A caller that opens a second one while this is held names it, so
    the two cannot collide.
    """
    clauses, params = conditions(filters)
    where = " AND ".join((*clauses, *extra, ONE_VIEWING_SQL))
    connection.execute(f"DROP TABLE IF EXISTS {table}")
    connection.execute(
        f"CREATE TEMP TABLE {table} AS {BASE_SELECT} WHERE {where}",
        (*params, *extra_params),
    )
    try:
        yield table
    finally:
        connection.execute(f"DROP TABLE IF EXISTS {table}")


def utc(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def utc_or_none(epoch: int | None) -> datetime | None:
    """The same, for a column that may hold nothing: a title never played
    inside the window, an item the library never dated."""
    return utc(epoch) if epoch is not None else None


def stamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def quality(rank: int | None) -> Quality | None:
    return RANK_QUALITY.get(rank) if rank else None


def hosts(concatenated: str | None) -> tuple[str, ...]:
    return tuple(sorted(concatenated.split(","))) if concatenated else ()


def identities(connection: sqlite3.Connection) -> tuple[dict[int, str], dict[int, str]]:
    """Names and avatars by account id, the first non-empty one across hosts.

    The owner is id 1 on every server and a shared user carries the same
    plex.tv id everywhere, so one map serves the fleet. A server that lists an
    account nameless does not blank a name another server knows.
    """
    names: dict[int, str] = {}
    thumbs: dict[int, str] = {}
    for row in connection.execute(
        "SELECT account_id, name, thumb FROM plex_accounts ORDER BY host, account_id"
    ):
        if row["name"]:
            names.setdefault(row["account_id"], row["name"])
        if row["thumb"]:
            thumbs.setdefault(row["account_id"], row["thumb"])
    return names, thumbs


def name(names: dict[int, str], account_id: int) -> str:
    """A viewer nobody has named keeps their id: a play must never be
    dropped, or shown under someone else's name, for want of one."""
    return names.get(account_id) or f"account {account_id}"
