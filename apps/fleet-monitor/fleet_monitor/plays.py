"""The play-history store: schema, writes, cursors, and every aggregate the
API serves.

One SQLite file holds the fleet. Every table is prefixed `plex_` and keyed by
the config host name, so one query answers for five servers and a host filter
is one predicate. Every function takes a connection: sessions come from
`db.session` and a pass's page of plays commits with its cursor, or neither
does.

Two rules the aggregates share, stated once here because every view leans on
them:

- A play is grouped by what a viewer would name: a movie by (title, year), an
  episode by its show, a track by its album. The same film on two servers is
  one row listing both. A play whose item is gone from the library keeps its
  own title and groups under it, since nothing better is known.
- A rewatch is the same viewer finishing the same item again. It is counted
  per (viewer, item) as plays minus one and summed over the group, so a
  viewer working through ten episodes has rewatched nothing.
"""

import sqlite3
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from fleet_monitor.probes.plex import (
    QUALITY_RANK,
    Account,
    Device,
    Kind,
    MediaItem,
    PlayEntry,
    Quality,
    Section,
    ServerInfo,
)

# The four buckets the page groups video by, in the order it lists them.
# `other` folds sd and unknown together: a play whose item was deleted since
# has no resolution on record, and inventing one would be worse than a fourth
# column.
QualityFilter = Literal["4k", "1080p", "720p", "other"]
QUALITY_FILTERS: tuple[QualityFilter, ...] = ("4k", "1080p", "720p", "other")
KIND_ORDER: tuple[Kind, ...] = ("movie", "episode", "track")

Metric = Literal["plays", "rewatches"]
Bucket = Literal["day", "week", "month"]

# Windows up to a month are drawn by day, up to half a year by week, and
# anything wider by month, so a year of history is twelve bars rather than
# three hundred and sixty five slivers.
_DAY_BUCKET_MAX_DAYS = 31
_WEEK_BUCKET_MAX_DAYS = 180
_TOP_COUNT = 5

_SERVERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_servers (
    host              TEXT PRIMARY KEY,
    friendly_name     TEXT,
    machine_id        TEXT,
    version           TEXT,
    history_cursor    INTEGER,
    history_synced_at TEXT,
    history_ok        INTEGER NOT NULL DEFAULT 0,
    library_synced_at TEXT,
    library_ok        INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT
)
"""

_ACCOUNTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_accounts (
    host       TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    thumb      TEXT,
    PRIMARY KEY (host, account_id)
)
"""

_DEVICES_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_devices (
    host              TEXT NOT NULL,
    device_id         INTEGER NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    platform          TEXT,
    client_identifier TEXT,
    PRIMARY KEY (host, device_id)
)
"""

_SECTIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_sections (
    host       TEXT NOT NULL,
    section_id TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    excluded   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (host, section_id)
)
"""

_ITEMS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_items (
    host                   TEXT NOT NULL,
    rating_key             TEXT NOT NULL,
    kind                   TEXT NOT NULL,
    title                  TEXT NOT NULL DEFAULT '',
    parent_rating_key      TEXT,
    parent_title           TEXT,
    parent_index           INTEGER,
    grandparent_rating_key TEXT,
    grandparent_title      TEXT,
    item_index             INTEGER,
    year                   INTEGER,
    section_id             TEXT,
    duration_ms            INTEGER,
    video_resolution       TEXT,
    width                  INTEGER,
    height                 INTEGER,
    quality                TEXT,
    thumb                  TEXT,
    added_at               INTEGER,
    present                INTEGER NOT NULL DEFAULT 1,
    seen_at                TEXT NOT NULL,
    PRIMARY KEY (host, rating_key)
)
"""

_PLAYS_SCHEMA = """
CREATE TABLE IF NOT EXISTS plex_plays (
    host       TEXT NOT NULL,
    history_id INTEGER NOT NULL,
    rating_key TEXT NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    section_id TEXT,
    account_id INTEGER NOT NULL,
    device_id  INTEGER,
    viewed_at  INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'history',
    PRIMARY KEY (host, history_id)
)
"""

_INDEXES = (
    "CREATE INDEX IF NOT EXISTS ix_plex_plays_viewed ON plex_plays (viewed_at)",
    "CREATE INDEX IF NOT EXISTS ix_plex_plays_item ON plex_plays (host, rating_key)",
    "CREATE INDEX IF NOT EXISTS ix_plex_plays_account ON plex_plays (account_id)",
    "CREATE INDEX IF NOT EXISTS ix_plex_items_kind ON plex_items (host, kind, present)",
)

# How a stored quality label ranks, as SQL, so a group can take its best one.
_QUALITY_RANK_SQL = (
    "CASE {column} WHEN '4k' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 "
    "WHEN 'sd' THEN 1 ELSE 0 END"
)
_RANK_QUALITY: dict[int, Quality] = {rank: quality for quality, rank in QUALITY_RANK.items()}

# The best title known for a play's item: the library's, then the ledger's
# own, then a placeholder. The ledger does record completions with a blank
# title (measured 2026-09-18: a hundred or so episodes across the fleet), and
# a blank must not become a group that ranks.
_ITEM_TITLE_SQL = "COALESCE(NULLIF(i.title, ''), NULLIF(p.title, ''), 'Untitled')"

# Every play joined to what is known about its item.
#
# An episode whose show is not known, or a track whose album is not, groups as
# itself rather than under its own title. Before this every unknown "Episode
# 1" from every unknown show landed in one row called "Episode 1", which was
# the top title on the fleet the first time real data was read. An item stands
# alone until its metadata arrives, and it says so in its context.
_BASE_SELECT = f"""
    SELECT p.host, p.history_id, p.rating_key, p.kind, p.account_id, p.device_id,
           p.section_id, p.viewed_at,
           {_ITEM_TITLE_SQL} AS item_title,
           i.parent_title, i.grandparent_title, i.parent_index, i.item_index, i.year,
           i.quality, i.duration_ms, i.thumb,
           CASE p.kind
             WHEN 'movie' THEN
               CASE WHEN COALESCE(NULLIF(i.title, ''), NULLIF(p.title, '')) IS NULL
                    THEN 'item:' || p.host || ':' || p.rating_key
                    ELSE 'movie:' || lower({_ITEM_TITLE_SQL})
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
             WHEN 'movie' THEN {_ITEM_TITLE_SQL}
             WHEN 'episode' THEN COALESCE(NULLIF(i.grandparent_title, ''), {_ITEM_TITLE_SQL})
             ELSE COALESCE(NULLIF(i.parent_title, ''), {_ITEM_TITLE_SQL})
           END AS group_title,
           CASE p.kind
             WHEN 'episode' THEN
               CASE WHEN NULLIF(i.grandparent_title, '') IS NULL THEN 'show not known' END
             WHEN 'track' THEN
               CASE WHEN NULLIF(i.parent_title, '') IS NULL THEN 'album not known'
                    ELSE i.grandparent_title END
           END AS group_context,
           CASE p.kind WHEN 'movie' THEN i.year END AS group_year,
           {_QUALITY_RANK_SQL.format(column="i.quality")} AS quality_rank
    FROM plex_plays p
    LEFT JOIN plex_items i ON i.host = p.host AND i.rating_key = p.rating_key
"""


@dataclass(frozen=True, slots=True)
class Filters:
    """What every view narrows by. `since` is an inclusive epoch floor, or
    None for all time. A quality filter is a statement about video, so it
    excludes tracks whichever bucket it names."""

    since: int | None = None
    host: str | None = None
    kind: Kind | None = None
    quality: QualityFilter | None = None


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
    quality: QualityFilter
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
    quality: QualityFilter
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


@dataclass(frozen=True, slots=True)
class Purged:
    """What one purge of the excluded libraries removed."""

    plays: int
    items: int


@dataclass(frozen=True, slots=True)
class ServerStatus:
    host: str
    friendly_name: str | None
    plex_url: str
    reachable: bool
    history_synced_at: datetime | None
    library_synced_at: datetime | None
    history_since: datetime | None
    plays: int
    items: int
    last_error: str | None


def init_db(connection: sqlite3.Connection) -> None:
    """Every table this module writes, and the one column a database written
    before the exclusion rule existed does not have. CREATE TABLE IF NOT
    EXISTS never widens an existing table, so the column is added by hand or
    every section read answers "no such column". Nothing is excluded by the
    backfill: the next inventory pass says which sections are."""
    for statement in (
        _SERVERS_SCHEMA,
        _ACCOUNTS_SCHEMA,
        _DEVICES_SCHEMA,
        _SECTIONS_SCHEMA,
        _ITEMS_SCHEMA,
        _PLAYS_SCHEMA,
        *_INDEXES,
    ):
        connection.execute(statement)
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(plex_sections)")}
    if "excluded" not in columns:
        connection.execute(
            "ALTER TABLE plex_sections ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0"
        )


# --- writes ---------------------------------------------------------------


def upsert_server(connection: sqlite3.Connection, host: str, *, info: ServerInfo) -> None:
    """Who the server says it is. Leaves the cursor and the sync marks alone:
    a server re-identifying itself has not re-read its history."""
    connection.execute(
        """
        INSERT INTO plex_servers (host, friendly_name, machine_id, version)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            friendly_name = excluded.friendly_name,
            machine_id = excluded.machine_id,
            version = excluded.version
        """,
        (host, info.friendly_name, info.machine_id, info.version),
    )


def mark_history(
    connection: sqlite3.Connection,
    host: str,
    *,
    at: datetime,
    ok: bool,
    error: str | None,
) -> None:
    """The outcome of one history pass. Creates the row when the server has
    never been identified, so a pass that failed at the first request is still
    visible on /plays/sync rather than being a host with no row at all."""
    connection.execute(
        """
        INSERT INTO plex_servers (host, history_synced_at, history_ok, last_error)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            history_synced_at = excluded.history_synced_at,
            history_ok = excluded.history_ok,
            last_error = excluded.last_error
        """,
        (host, at.isoformat(), 1 if ok else 0, error),
    )


def mark_library(
    connection: sqlite3.Connection,
    host: str,
    *,
    at: datetime,
    ok: bool,
    error: str | None,
) -> None:
    """The outcome of one inventory pass. A failure names itself in
    last_error; a success leaves whatever the history pass last said."""
    connection.execute(
        """
        INSERT INTO plex_servers (host, library_synced_at, library_ok, last_error)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host) DO UPDATE SET
            library_synced_at = excluded.library_synced_at,
            library_ok = excluded.library_ok,
            last_error = COALESCE(excluded.last_error, plex_servers.last_error)
        """,
        (host, at.isoformat(), 1 if ok else 0, error),
    )


def set_history_cursor(connection: sqlite3.Connection, host: str, cursor: int) -> None:
    """The newest viewedAt a pass has stored. Advanced per page, so a pass
    that dies mid-backfill resumes from the last page that committed."""
    connection.execute(
        """
        INSERT INTO plex_servers (host, history_cursor) VALUES (?, ?)
        ON CONFLICT(host) DO UPDATE SET history_cursor = excluded.history_cursor
        """,
        (host, cursor),
    )


def history_cursor(connection: sqlite3.Connection, host: str) -> int | None:
    row = connection.execute(
        "SELECT history_cursor FROM plex_servers WHERE host = ?", (host,)
    ).fetchone()
    return row["history_cursor"] if row is not None else None


def upsert_accounts(
    connection: sqlite3.Connection, host: str, accounts: Iterable[Account]
) -> None:
    connection.executemany(
        """
        INSERT INTO plex_accounts (host, account_id, name, thumb) VALUES (?, ?, ?, ?)
        ON CONFLICT(host, account_id) DO UPDATE SET
            name = excluded.name, thumb = excluded.thumb
        """,
        [(host, a.account_id, a.name, a.thumb) for a in accounts],
    )


def upsert_devices(connection: sqlite3.Connection, host: str, devices: Iterable[Device]) -> None:
    connection.executemany(
        """
        INSERT INTO plex_devices (host, device_id, name, platform, client_identifier)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host, device_id) DO UPDATE SET
            name = excluded.name,
            platform = excluded.platform,
            client_identifier = excluded.client_identifier
        """,
        [(host, d.device_id, d.name, d.platform, d.client_identifier) for d in devices],
    )


def upsert_sections(
    connection: sqlite3.Connection,
    host: str,
    sections: Iterable[Section],
    *,
    excluded_ids: Collection[str] = (),
) -> None:
    """The libraries this server holds, each carrying whether the play page
    counts it. The flag is stored rather than recomputed per query because the
    history pass has to drop a play before it lands, and it reads the store,
    not the server's section listing."""
    connection.executemany(
        """
        INSERT INTO plex_sections (host, section_id, title, kind, excluded)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host, section_id) DO UPDATE SET
            title = excluded.title, kind = excluded.kind, excluded = excluded.excluded
        """,
        [
            (host, s.section_id, s.title, s.kind, 1 if s.section_id in excluded_ids else 0)
            for s in sections
        ],
    )


def excluded_section_ids(connection: sqlite3.Connection, host: str) -> frozenset[str]:
    """The sections on this host the page leaves out, as the last inventory
    pass marked them. Empty until one has run, which is the safe direction:
    a play kept for one round is purged by that pass, a play dropped in error
    is gone for good."""
    rows = connection.execute(
        "SELECT section_id FROM plex_sections WHERE host = ? AND excluded = 1", (host,)
    ).fetchall()
    return frozenset(row["section_id"] for row in rows)


def purge_sections(
    connection: sqlite3.Connection, host: str, section_ids: Collection[str]
) -> Purged:
    """Delete every play and item belonging to these sections. Returns how
    many of each went.

    Plays first, by their own section and by their item's: the ledger names
    the section on most rows, but a row that does not carries the item that
    does, and an excluded library must not survive on the technicality.
    """
    if not section_ids:
        return Purged(plays=0, items=0)
    marks = ", ".join("?" for _ in section_ids)
    ids = tuple(section_ids)
    plays_gone = connection.execute(
        f"""
        DELETE FROM plex_plays
        WHERE host = ? AND (
            section_id IN ({marks})
            OR rating_key IN (
                SELECT rating_key FROM plex_items
                WHERE host = ? AND section_id IN ({marks})
            )
        )
        """,
        (host, *ids, host, *ids),
    ).rowcount
    items_gone = connection.execute(
        f"DELETE FROM plex_items WHERE host = ? AND section_id IN ({marks})",
        (host, *ids),
    ).rowcount
    return Purged(plays=plays_gone, items=items_gone)


def upsert_items(
    connection: sqlite3.Connection,
    host: str,
    items: Iterable[MediaItem],
    *,
    seen_at: datetime,
) -> None:
    """Items as the server describes them now. An item seen again is present
    again, whatever a retire pass said before: the inventory is the authority
    on what is in the library."""
    connection.executemany(
        """
        INSERT INTO plex_items (
            host, rating_key, kind, title, parent_rating_key, parent_title, parent_index,
            grandparent_rating_key, grandparent_title, item_index, year, section_id,
            duration_ms, video_resolution, width, height, quality, thumb, added_at,
            present, seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(host, rating_key) DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            parent_rating_key = excluded.parent_rating_key,
            parent_title = excluded.parent_title,
            parent_index = excluded.parent_index,
            grandparent_rating_key = excluded.grandparent_rating_key,
            grandparent_title = excluded.grandparent_title,
            item_index = excluded.item_index,
            year = excluded.year,
            section_id = excluded.section_id,
            duration_ms = excluded.duration_ms,
            video_resolution = excluded.video_resolution,
            width = excluded.width,
            height = excluded.height,
            quality = excluded.quality,
            thumb = excluded.thumb,
            added_at = excluded.added_at,
            present = 1,
            seen_at = excluded.seen_at
        """,
        [
            (
                host,
                item.rating_key,
                item.kind,
                item.title,
                item.parent_rating_key,
                item.parent_title,
                item.parent_index,
                item.grandparent_rating_key,
                item.grandparent_title,
                item.index,
                item.year,
                item.section_id,
                item.duration_ms,
                item.video_resolution,
                item.width,
                item.height,
                item.quality,
                item.thumb,
                item.added_at,
                seen_at.isoformat(),
            )
            for item in items
        ],
    )


def stub_missing_items(
    connection: sqlite3.Connection, host: str, keys: Sequence[str], *, seen_at: datetime
) -> None:
    """A row for every played item the server no longer answers for.

    Absent, not present: the play keeps its own title and no quality, and the
    key stops being asked for on every pass. Should the item come back, the
    inventory's upsert overwrites the stub and marks it present again.
    """
    if not keys:
        return
    marks = ", ".join("?" for _ in keys)
    connection.execute(
        f"""
        INSERT OR IGNORE INTO plex_items (host, rating_key, kind, title, present, seen_at)
        SELECT host, rating_key, MIN(kind), MIN(title), 0, ?
        FROM plex_plays
        WHERE host = ? AND rating_key IN ({marks})
        GROUP BY host, rating_key
        """,
        (seen_at.isoformat(), host, *keys),
    )


def retire_unseen_items(
    connection: sqlite3.Connection, host: str, *, seen_before: datetime
) -> int:
    """Mark absent every item a complete inventory run did not see. Returns
    how many. Only a run that paged every section to its end may call this:
    a run that failed mid-section would otherwise retire the whole library
    behind the failure."""
    cursor = connection.execute(
        "UPDATE plex_items SET present = 0 WHERE host = ? AND present = 1 AND seen_at < ?",
        (host, seen_before.isoformat()),
    )
    return cursor.rowcount


def insert_plays(connection: sqlite3.Connection, host: str, plays: Iterable[PlayEntry]) -> int:
    """Insert what is new, ignore what is already there. Returns how many were
    new. Idempotent on the server's own history id, which is what makes the
    overlap re-read and the resume-after-crash free."""
    rows = [
        (
            host,
            play.history_id,
            play.rating_key,
            play.kind,
            play.title,
            play.section_id,
            play.account_id,
            play.device_id,
            play.viewed_at,
        )
        for play in plays
    ]
    if not rows:
        return 0
    before = connection.total_changes
    connection.executemany(
        """
        INSERT OR IGNORE INTO plex_plays (
            host, history_id, rating_key, kind, title, section_id, account_id, device_id,
            viewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    return connection.total_changes - before


def missing_item_keys(connection: sqlite3.Connection, host: str, *, limit: int) -> tuple[str, ...]:
    """Played items on this host with no item row at all: what the next
    enrichment batch asks the server about."""
    rows = connection.execute(
        """
        SELECT DISTINCT p.rating_key
        FROM plex_plays p
        LEFT JOIN plex_items i ON i.host = p.host AND i.rating_key = p.rating_key
        WHERE p.host = ? AND i.rating_key IS NULL
        ORDER BY p.rating_key
        LIMIT ?
        """,
        (host, limit),
    ).fetchall()
    return tuple(row["rating_key"] for row in rows)


def earliest_play(connection: sqlite3.Connection, *, host: str | None) -> int | None:
    """The oldest stored viewedAt, fleet-wide or for one host."""
    if host is None:
        row = connection.execute("SELECT MIN(viewed_at) AS at FROM plex_plays").fetchone()
    else:
        row = connection.execute(
            "SELECT MIN(viewed_at) AS at FROM plex_plays WHERE host = ?", (host,)
        ).fetchone()
    return row["at"] if row is not None else None


# --- shared query pieces --------------------------------------------------


def _conditions(filters: Filters) -> tuple[list[str], list[object]]:
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
        clauses.append("p.kind != 'track' AND (i.quality IS NULL OR i.quality = 'sd')")
    elif filters.quality is not None:
        clauses.append("i.quality = ?")
        params.append(filters.quality)
    return clauses, params


def _base_cte(filters: Filters, *, extra: Sequence[str] = ()) -> tuple[str, list[object]]:
    clauses, params = _conditions(filters)
    clauses.extend(extra)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return f"WITH base AS ({_BASE_SELECT}{where})", params


def _utc(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def _stamp(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _quality(rank: int | None) -> Quality | None:
    return _RANK_QUALITY.get(rank) if rank else None


def _hosts(concatenated: str | None) -> tuple[str, ...]:
    return tuple(sorted(concatenated.split(","))) if concatenated else ()


def _identities(connection: sqlite3.Connection) -> tuple[dict[int, str], dict[int, str]]:
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


def _name(names: dict[int, str], account_id: int) -> str:
    """A viewer nobody has named keeps their id: a play must never be
    dropped, or shown under someone else's name, for want of one."""
    return names.get(account_id) or f"account {account_id}"


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


# --- aggregates -----------------------------------------------------------


def top_titles(
    connection: sqlite3.Connection, filters: Filters, *, metric: Metric, limit: int
) -> tuple[TopTitle, ...]:
    """The most played, or most rewatched, groups under the filters.

    Ties fall to the more recently played, so a page sorted by plays does not
    reshuffle its equal rows between refreshes.
    """
    cte, params = _base_cte(filters)
    only_rewatched = "WHERE r.rewatches > 0" if metric == "rewatches" else ""
    order = "r.rewatches DESC, g.plays DESC" if metric == "rewatches" else "g.plays DESC"
    rows = connection.execute(
        f"""
        {cte},
        per_item AS (
            SELECT group_key, account_id, host, rating_key, COUNT(*) AS plays
            FROM base
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
            FROM base
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
        (*params, limit),
    ).fetchall()
    names, _ = _identities(connection)
    return tuple(
        TopTitle(
            key=row["group_key"],
            kind=row["kind"],
            title=row["title"],
            context=row["context"],
            year=row["year"],
            quality=_quality(row["quality_rank"]),
            plays=row["plays"],
            viewers=row["viewers"],
            items=row["items"],
            rewatches=row["rewatches"],
            top_rewatcher=(
                Rewatcher(
                    account_id=row["rewatcher_id"],
                    name=_name(names, row["rewatcher_id"]),
                    plays=row["rewatcher_plays"],
                )
                if row["rewatcher_plays"] > 1
                else None
            ),
            last_viewed_at=_utc(row["last_viewed_at"]),
            hosts=_hosts(row["hosts"]),
            thumb=row["thumb"],
        )
        for row in rows
    )


def overview(
    connection: sqlite3.Connection,
    filters: Filters,
    *,
    hosts: Sequence[str],
    now: datetime,
) -> Overview:
    """Everything the overview panel draws, in one read.

    `hosts` is the fleet in config order: by_host is zero-filled in that
    order because the portal binds one colour per position, the same binding
    the fleet page uses, and a host with no plays must keep its slot.
    """
    cte, params = _base_cte(filters)
    totals_row = connection.execute(
        f"""
        {cte}
        SELECT COUNT(*) AS plays,
               COUNT(DISTINCT account_id) AS viewers,
               COUNT(DISTINCT group_key) AS titles,
               COALESCE(SUM(duration_ms), 0) AS watch_ms
        FROM base
        """,
        params,
    ).fetchone()
    by_kind = dict(
        connection.execute(
            f"{cte} SELECT kind, COUNT(*) FROM base GROUP BY kind", params
        ).fetchall()
    )
    by_quality = dict(
        connection.execute(
            f"""
            {cte}
            SELECT CASE WHEN quality IN ('4k', '1080p', '720p') THEN quality ELSE 'other' END AS q,
                   COUNT(*)
            FROM base
            WHERE kind != 'track'
            GROUP BY q
            """,
            params,
        ).fetchall()
    )
    by_host = dict(
        connection.execute(
            f"{cte} SELECT host, COUNT(*) FROM base GROUP BY host", params
        ).fetchall()
    )
    friendly = dict(
        connection.execute("SELECT host, friendly_name FROM plex_servers").fetchall()
    )

    since = filters.since if filters.since is not None else earliest_play(
        connection, host=filters.host
    )
    bucket = _bucket(since=since, now=now)
    points: dict[str, dict[str, int]] = {}
    for row in connection.execute(
        f"""
        {cte}
        SELECT {_BUCKET_SQL[bucket]} AS start, host, COUNT(*) AS plays
        FROM base
        GROUP BY start, host
        ORDER BY start, host
        """,
        params,
    ):
        points.setdefault(row["start"], {})[row["host"]] = row["plays"]

    names, _ = _identities(connection)
    viewers = connection.execute(
        f"""
        {cte}
        SELECT account_id, COUNT(*) AS plays
        FROM base
        GROUP BY account_id
        ORDER BY plays DESC, account_id
        LIMIT ?
        """,
        (*params, _TOP_COUNT),
    ).fetchall()

    return Overview(
        totals=Totals(
            plays=totals_row["plays"],
            viewers=totals_row["viewers"],
            titles=totals_row["titles"],
            watch_ms=totals_row["watch_ms"],
        ),
        by_kind=tuple(KindCount(kind=kind, plays=by_kind.get(kind, 0)) for kind in KIND_ORDER),
        by_quality=tuple(
            QualityCount(quality=quality, plays=by_quality.get(quality, 0))
            for quality in QUALITY_FILTERS
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
            Viewer(account_id=row["account_id"], name=_name(names, row["account_id"]),
                   plays=row["plays"])
            for row in viewers
        ),
        top_titles=top_titles(connection, filters, metric="plays", limit=_TOP_COUNT),
    )


def users(connection: sqlite3.Connection, filters: Filters) -> tuple[User, ...]:
    """Every viewer with a play under the filters, most plays first."""
    cte, params = _base_cte(filters)
    rows = connection.execute(
        f"""
        {cte}
        SELECT account_id,
               COUNT(*) AS plays,
               SUM(kind = 'movie') AS movies,
               SUM(kind = 'episode') AS episodes,
               SUM(kind = 'track') AS tracks,
               MAX(viewed_at) AS last_viewed_at,
               GROUP_CONCAT(DISTINCT host) AS hosts
        FROM base
        GROUP BY account_id
        ORDER BY plays DESC, account_id
        """,
        params,
    ).fetchall()
    # the group a viewer has played most, alphabetical on a tie so the
    # favourite does not flicker between refreshes
    favourites: dict[int, str] = {}
    for row in connection.execute(
        f"""
        {cte}
        SELECT account_id, group_title, COUNT(*) AS plays
        FROM base
        GROUP BY account_id, group_key
        ORDER BY account_id, plays DESC, group_title
        """,
        params,
    ):
        favourites.setdefault(row["account_id"], row["group_title"])
    names, thumbs = _identities(connection)
    return tuple(
        User(
            account_id=row["account_id"],
            name=_name(names, row["account_id"]),
            thumb=thumbs.get(row["account_id"]),
            plays=row["plays"],
            movies=row["movies"],
            episodes=row["episodes"],
            tracks=row["tracks"],
            hosts=_hosts(row["hosts"]),
            last_viewed_at=_utc(row["last_viewed_at"]),
            top_title=favourites.get(row["account_id"]),
        )
        for row in rows
    )


def user_history(
    connection: sqlite3.Connection,
    filters: Filters,
    *,
    account_id: int,
    page: int,
    page_size: int,
) -> HistoryPage:
    """One viewer's plays, newest first, one page at a time."""
    cte, params = _base_cte(filters, extra=("p.account_id = ?",))
    params = [*params, account_id]
    total = connection.execute(f"{cte} SELECT COUNT(*) AS total FROM base", params).fetchone()[
        "total"
    ]
    rows = connection.execute(
        f"""
        {cte}
        SELECT b.viewed_at, b.host, b.kind, b.group_key, b.item_title AS title, b.parent_title,
               b.grandparent_title, b.item_index, b.parent_index, b.year, b.quality,
               b.duration_ms, d.name AS device, s.title AS library
        FROM base b
        LEFT JOIN plex_devices d ON d.host = b.host AND d.device_id = b.device_id
        LEFT JOIN plex_sections s ON s.host = b.host AND s.section_id = b.section_id
        ORDER BY b.viewed_at DESC, b.history_id DESC
        LIMIT ? OFFSET ?
        """,
        (*params, page_size, (page - 1) * page_size),
    ).fetchall()
    names, _ = _identities(connection)
    return HistoryPage(
        account_id=account_id,
        name=_name(names, account_id),
        total=total,
        page=page,
        page_size=page_size,
        rows=tuple(
            HistoryRow(
                viewed_at=_utc(row["viewed_at"]),
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


# --- title history --------------------------------------------------------

# What names a group, read from its most recent play. Used on its own, with
# no window, so a title stays named under a filter that holds none of its
# plays: the page has only the key, and an unnamed heading would read as a
# title that had been deleted rather than one nobody watched this month.
_TITLE_IDENTITY_SQL = """
    SELECT kind, group_title, group_context, group_year, quality_rank
    FROM base
    WHERE group_key = ?
    ORDER BY viewed_at DESC, history_id DESC
    LIMIT 1
"""


def title_history(
    connection: sqlite3.Connection,
    filters: Filters,
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
    cte, params = _base_cte(filters)
    scoped = [*params, key]
    summary = connection.execute(
        f"""
        {cte},
        scoped AS (SELECT * FROM base WHERE group_key = ?),
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
        scoped,
    ).fetchone()

    kind = summary["kind"]
    title = summary["title"]
    context = summary["context"]
    year = summary["year"]
    quality_rank = summary["quality_rank"]
    if kind is None:
        # nothing under the filters: name the title from the ledger at large
        unfiltered, _ = _base_cte(Filters())
        named = connection.execute(f"{unfiltered} {_TITLE_IDENTITY_SQL}", (key,)).fetchone()
        if named is not None:
            kind = named["kind"]
            title = named["group_title"]
            context = named["group_context"]
            year = named["group_year"]
            quality_rank = named["quality_rank"]

    names, _ = _identities(connection)
    rows = connection.execute(
        f"""
        {cte}
        SELECT b.viewed_at, b.host, b.kind, b.account_id, b.item_title AS title,
               b.item_index, b.parent_index, b.year, b.quality, b.duration_ms,
               d.name AS device, s.title AS library
        FROM base b
        LEFT JOIN plex_devices d ON d.host = b.host AND d.device_id = b.device_id
        LEFT JOIN plex_sections s ON s.host = b.host AND s.section_id = b.section_id
        WHERE b.group_key = ?
        ORDER BY b.viewed_at DESC, b.history_id DESC
        LIMIT ? OFFSET ?
        """,
        (*scoped, page_size, (page - 1) * page_size),
    ).fetchall()

    return TitleHistoryPage(
        key=key,
        kind=kind,
        title=title or "",
        context=context,
        year=year,
        quality=_quality(quality_rank),
        viewers=summary["viewers"],
        items=summary["items"],
        rewatches=summary["rewatches"],
        first_viewed_at=(
            _utc(summary["first_viewed_at"]) if summary["first_viewed_at"] is not None else None
        ),
        last_viewed_at=(
            _utc(summary["last_viewed_at"]) if summary["last_viewed_at"] is not None else None
        ),
        hosts=_hosts(summary["hosts"]),
        total=summary["total"],
        page=page,
        page_size=page_size,
        rows=tuple(
            TitleHistoryRow(
                viewed_at=_utc(row["viewed_at"]),
                host=row["host"],
                kind=row["kind"],
                account_id=row["account_id"],
                viewer=_name(names, row["account_id"]),
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


_NEVER_KIND: dict[Kind, NeverKind] = {"movie": "movie", "episode": "show", "track": "album"}

# Everything in the library nobody has finished inside the window, grouped
# the way the ranked views group: a film is itself, a show is one row however
# many episodes it has, an album likewise. A show or album with one played
# episode or track is not never-played, so the group is kept only when none
# of its members was.
_UNPLAYED_CTE = f"""
WITH played AS (
    SELECT DISTINCT host, rating_key FROM plex_plays {{since}}
),
candidates AS (
    SELECT i.host, i.rating_key, i.kind, i.title, i.parent_rating_key, i.parent_title,
           i.grandparent_rating_key, i.grandparent_title, i.year, i.section_id, i.added_at,
           i.thumb,
           {_QUALITY_RANK_SQL.format(column="i.quality")} AS quality_rank,
           (p.rating_key IS NOT NULL) AS played
    FROM plex_items i
    LEFT JOIN played p ON p.host = i.host AND p.rating_key = i.rating_key
    WHERE i.present = 1 {{host}}
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
    filters: Filters,
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
    params: list[object] = []
    since = ""
    if filters.since is not None:
        since = "WHERE viewed_at >= ?"
        params.append(filters.since)
    host = ""
    if filters.host is not None:
        host = "AND i.host = ?"
        params.append(filters.host)
    cte = _UNPLAYED_CTE.format(since=since, host=host)

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


def _never_played_page(
    connection: sqlite3.Connection,
    filters: Filters,
    *,
    hosts: Sequence[str],
    page: int,
    page_size: int,
    q: str,
    now: datetime,
) -> NeverPlayedPage:
    """The summary and one page of rows, read from the materialised set."""
    # Every clause names the alias: the rows query joins the sections table,
    # which has `kind` and `title` columns of its own, and a bare column name
    # there is an ambiguity error rather than a filter.
    search_clause = ""
    search_params: list[object] = []
    if q.strip():
        # instr rather than LIKE, so a % or _ in the search is a character
        search_clause = "instr(lower(u.title), lower(?)) > 0"
        search_params.append(q.strip())

    summary_where = f"WHERE {search_clause}" if search_clause else ""
    kinds = dict(
        connection.execute(
            f"SELECT u.kind, COUNT(*) FROM unplayed_now u {summary_where} GROUP BY u.kind",
            search_params,
        ).fetchall()
    )
    movie_where = f"WHERE u.kind = 'movie'{' AND ' + search_clause if search_clause else ''}"
    by_quality = dict(
        connection.execute(
            f"""
            SELECT CASE u.quality_rank WHEN 4 THEN '4k' WHEN 3 THEN '1080p' WHEN 2 THEN '720p'
                   ELSE 'other' END AS q, COUNT(*)
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

    row_clauses = list(filter(None, [search_clause]))
    row_params = list(search_params)
    if filters.kind is not None:
        row_clauses.append("u.kind = ?")
        row_params.append(_NEVER_KIND[filters.kind])
    if filters.quality == "other":
        # unknown or sd video; an album has no video and is not "other"
        row_clauses.append("u.kind != 'album' AND u.quality_rank <= 1")
    elif filters.quality is not None:
        row_clauses.append("u.kind != 'album' AND u.quality_rank = ?")
        row_params.append(QUALITY_RANK[filters.quality])
    row_where = f"WHERE {' AND '.join(row_clauses)}" if row_clauses else ""

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
                for quality in QUALITY_FILTERS
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
                quality=_quality(row["quality_rank"]),
                library=row["library"],
                added_at=_utc(row["added_at"]) if row["added_at"] is not None else None,
                items=row["items"],
                thumb=row["thumb"],
            )
            for row in rows
        ),
    )


def sync_status(
    connection: sqlite3.Connection, *, hosts: Sequence[tuple[str, str]]
) -> tuple[ServerStatus, ...]:
    """One line per Plex host handed in, as (name, url), whether or not a
    pass has ever reached it. A host with no row is listed unreachable and
    empty rather than left out: absence from the page would read as absence
    from the fleet."""
    servers = {
        row["host"]: row
        for row in connection.execute(
            """
            SELECT host, friendly_name, history_synced_at, history_ok, library_synced_at,
                   last_error
            FROM plex_servers
            """
        )
    }
    plays = {
        row["host"]: (row["plays"], row["since"])
        for row in connection.execute(
            "SELECT host, COUNT(*) AS plays, MIN(viewed_at) AS since FROM plex_plays GROUP BY host"
        )
    }
    items = dict(
        connection.execute(
            "SELECT host, COUNT(*) FROM plex_items WHERE present = 1 GROUP BY host"
        ).fetchall()
    )
    statuses = []
    for name, url in hosts:
        server = servers.get(name)
        count, since = plays.get(name, (0, None))
        statuses.append(
            ServerStatus(
                host=name,
                friendly_name=server["friendly_name"] if server else None,
                plex_url=url,
                reachable=bool(server["history_ok"]) if server else False,
                history_synced_at=_stamp(server["history_synced_at"]) if server else None,
                library_synced_at=_stamp(server["library_synced_at"]) if server else None,
                history_since=_utc(since) if since is not None else None,
                plays=count,
                items=items.get(name, 0),
                last_error=server["last_error"] if server else None,
            )
        )
    return tuple(statuses)
