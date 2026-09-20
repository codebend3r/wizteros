"""The play-history store: schema, writes, cursors, and every aggregate the
API serves.

One SQLite file holds the fleet. Every table is prefixed `plex_` and keyed by
the config host name, so one query answers for five servers and a host filter
is one predicate. Every function takes a connection: sessions come from
`db.session` and a pass's page of plays commits with its cursor, or neither
does.

The package is four modules and this re-export, so every caller keeps saying
`plays.overview(...)` whichever one the name moved to: `base` holds the
filters and the joined select, `ledger` the schema and the writes, `views`
the aggregates, `never_played` the unplayed engine.

Two rules the aggregates share, stated once here because every view leans on
them:

- A play is grouped by what a viewer would name: a movie by (title, year), an
  episode by its show, a track by its album. The same film on two servers is
  one row listing both. A play whose item is gone from the library keeps its
  own title and groups under it, since nothing better is known.
- A rewatch is the same viewer finishing the same item again. It is counted
  per (viewer, item) as plays minus one and summed over the group, so a
  viewer working through ten episodes has rewatched nothing.
- One viewing is one play, however many times Plex logged it. The server
  writes a history row each time an item is marked watched, and some clients
  mark a single viewing twice: once at the watched threshold, again at the
  stop (measured 2026-09-19: 222 of 6,253 rows fleet-wide, mostly iOS and
  tvOS, a minute or less apart in half of them). A completion that lands
  before the same viewer could even have replayed the item in full is the
  same viewing, and every read here drops it. The ledger keeps the row, so
  the rule can change without a resync.
"""

from fleet_monitor.plays.base import (
    KIND_ORDER,
    QUALITY_FILTERS,
    Filters,
    QualityFilter,
)
from fleet_monitor.plays.ledger import (
    Purged,
    ServerStatus,
    earliest_play,
    excluded_section_ids,
    history_cursor,
    init_db,
    insert_plays,
    mark_history,
    mark_library,
    missing_item_keys,
    purge_sections,
    retire_unseen_items,
    set_history_cursor,
    stub_missing_items,
    sync_status,
    upsert_accounts,
    upsert_devices,
    upsert_items,
    upsert_sections,
    upsert_server,
)
from fleet_monitor.plays.never_played import (
    NeverHostCount,
    NeverKind,
    NeverPlayedPage,
    NeverPlayedRow,
    NeverPlayedSummary,
    NeverQualityCount,
    never_played,
)
from fleet_monitor.plays.views import (
    Bucket,
    HistoryPage,
    HistoryRow,
    HostCount,
    KindCount,
    Metric,
    Overview,
    QualityCount,
    Rewatcher,
    Timeline,
    TimelinePoint,
    TitleHistoryPage,
    TitleHistoryRow,
    TopTitle,
    Totals,
    User,
    Viewer,
    overview,
    title_history,
    top_titles,
    user_history,
    users,
)

__all__ = [
    "KIND_ORDER",
    "QUALITY_FILTERS",
    "Bucket",
    "Filters",
    "HistoryPage",
    "HistoryRow",
    "HostCount",
    "KindCount",
    "Metric",
    "NeverHostCount",
    "NeverKind",
    "NeverPlayedPage",
    "NeverPlayedRow",
    "NeverPlayedSummary",
    "NeverQualityCount",
    "Overview",
    "Purged",
    "QualityCount",
    "QualityFilter",
    "Rewatcher",
    "ServerStatus",
    "Timeline",
    "TimelinePoint",
    "TitleHistoryPage",
    "TitleHistoryRow",
    "TopTitle",
    "Totals",
    "User",
    "Viewer",
    "earliest_play",
    "excluded_section_ids",
    "history_cursor",
    "init_db",
    "insert_plays",
    "mark_history",
    "mark_library",
    "missing_item_keys",
    "never_played",
    "overview",
    "purge_sections",
    "retire_unseen_items",
    "set_history_cursor",
    "stub_missing_items",
    "sync_status",
    "title_history",
    "top_titles",
    "upsert_accounts",
    "upsert_devices",
    "upsert_items",
    "upsert_sections",
    "upsert_server",
    "user_history",
    "users",
]
