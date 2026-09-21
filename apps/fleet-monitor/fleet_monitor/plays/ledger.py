"""The ledger itself: the schema, every write, and the cursors and status a
sync pass reads back.

Every function takes a connection, so a pass's page of plays commits with its
cursor or neither does.
"""

import sqlite3
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

from fleet_monitor import config
from fleet_monitor.plays import base
from fleet_monitor.probes.plex import (
    Account,
    Device,
    MediaItem,
    PlayEntry,
    Section,
    ServerInfo,
)

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


def sync_status(
    connection: sqlite3.Connection, *, hosts: Sequence[config.Host]
) -> tuple[ServerStatus, ...]:
    """One line per Plex host handed in, whether or not a pass has ever
    reached it. A host with no row is listed unreachable and empty rather
    than left out: absence from the page would read as absence from the
    fleet."""
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
    # through the same base every view reads, so the count on the sync line
    # is the count the overview totals to, not the ledger's raw row count
    with base.base_table(connection, base.Filters()) as table:
        plays = {
            row["host"]: (row["plays"], row["since"])
            for row in connection.execute(
                f"""
                SELECT host, COUNT(*) AS plays, MIN(viewed_at) AS since
                FROM {table}
                GROUP BY host
                """
            )
        }
    items = dict(
        connection.execute(
            "SELECT host, COUNT(*) FROM plex_items WHERE present = 1 GROUP BY host"
        ).fetchall()
    )
    return tuple(
        _status(host, server=servers.get(host.name), plays=plays, items=items)
        for host in hosts
    )


def _status(
    host: config.Host,
    *,
    server: sqlite3.Row | None,
    plays: dict[str, tuple[int, int | None]],
    items: dict[str, int],
) -> ServerStatus:
    """One host's line, from the three reads above."""
    count, since = plays.get(host.name, (0, None))
    return ServerStatus(
        host=host.name,
        friendly_name=server["friendly_name"] if server else None,
        plex_url=host.plex_url,
        reachable=bool(server["history_ok"]) if server else False,
        history_synced_at=base.stamp(server["history_synced_at"]) if server else None,
        library_synced_at=base.stamp(server["library_synced_at"]) if server else None,
        history_since=base.utc_or_none(since),
        plays=count,
        items=items.get(host.name, 0),
        last_error=server["last_error"] if server else None,
    )
