# Plex play history design

**Date:** 2026-09-18
**Status:** design, planned in `docs/superpowers/plans/2026-09-18-plex-play-history.md`
**Scope:** one admin page that answers who watched what, how often, at what quality, and what has never been watched, across all five Plex servers, with at least a year of history kept locally

## Problem

Playback history lives in five separate Plex databases and nowhere else in this stack. Tautulli
exists on the NAS but watches one server, only knows plays since the day it was installed, and
nothing in the repo reads it. There is no place to ask "which member watches the most", "what is
being rewatched", "how much 4K is actually played", or "what has nobody ever opened", and the sales
and tier decisions that want a usage signal have none.

## How Tautulli gets history, and what to keep from it

Read from the Tautulli source on 2026-09-18, not from memory:

- It opens a websocket to `/:/websockets/notifications` and handles `playing` events. Each event is
  enriched with one call to `/status/sessions`, parked in a temporary `sessions` table, and only
  written to `session_history` when the stream stops. Only movies, episodes and tracks are logged,
  and only past an ignore interval.
- The old polling loop (`check_active_sessions`) survives as a reconciliation pass after a websocket
  reconnect.
- Metadata comes from `/library/metadata/{ratingKey}` per item; the media-info table stores both the
  source resolution and the stream resolution.
- It cannot import history from before it was installed (FAQ, and open issues #2181 and #1611). The
  community workaround converts Plex's own history into a Tautulli database.
- A known PMS websocket bug drops the stop event, so a play's duration is invented when Tautulli
  restarts.

What is worth keeping: pure metadata enrichment for quality, one row per completed play, and the
rule that a play is a movie, an episode or a track. What is worth replacing: the event-driven
capture as the only source of truth. Plex already keeps a ledger of completed views, per account,
with a stable id, that an admin token can page through at will.

## What is actually available

Measured against the live servers on 2026-09-18 with the owner token:

| Server      | URL                          | PMS    | Sections | Plays, last 365 days |
| ----------- | ---------------------------- | ------ | -------- | -------------------- |
| `meleys`    | `http://192.168.50.2:32400`  | 1.43.4 | 24       | 1,599 (2,272 ever)   |
| `vermithor` | `https://192.168.50.3:32400` | 1.43.4 |          | not counted (https)  |
| `caraxes`   | `http://192.168.50.4:32400`  | 1.43.4 | 6        | 4,109                |
| `syrax`     | `http://192.168.50.5:32400`  | 1.43.4 | 4        | 661                  |
| `vhagar`    | `https://192.168.50.6:32400` | 1.43.4 |          | not counted (https)  |

Two servers require secure connections and close a plain-http socket without a response. Their
certificate is Plex's `*.plex.direct` wildcard, which cannot verify against a LAN IP, so the
collector connects to those two with verification off. The token still authorizes every request.

Endpoint facts the design depends on, all confirmed live:

- `GET /status/sessions/history/all` returns every account's completed views to the owner token.
  Rows carry `historyKey` (stable per server), `ratingKey`, `key`, `librarySectionID`, `type`,
  `title`, `thumb`, `viewedAt`, `accountID`, `deviceID`. They do **not** carry parent or grandparent
  titles, so an episode row says "Smoke" and nothing about Better Call Saul.
- `sort=viewedAt:asc` works, `viewedAt>=` is inclusive, and `X-Plex-Container-Start` / `Size`
  page it (500 rows in 0.11s).
- `GET /library/metadata/{k1},{k2},...` returns only the keys that still exist; a missing single key
  is a 404. Each item carries `Media[].videoResolution`, `width`, `height`, `bitrate`, `duration`,
  plus `parentTitle`, `grandparentTitle`, `index`, `parentIndex`, `year`, `librarySectionID`.
- `GET /library/sections/{id}/all?type=1|4|10` lists movies, episodes or tracks with the same
  `Media` block. Meleys holds 33,393 episodes in one section and 20,747 tracks in another, so the
  inventory has to be paged (1,000 rows in 1.2s) and paced.
- `GET /accounts` lists 62 accounts with `id`, `name`, `thumb`. The owner is id 1 on every server;
  shared users appear under their plex.tv id, which is the same number on every server they can
  see. `GET /devices` lists `id`, `name`, `platform`, `clientIdentifier`.
- `viewCount` and `lastViewedAt` on library items are the token owner's own state, not anyone
  else's, so never-played cannot come from them.

## Approaches considered

### A. Read Tautulli's API

One instance, one server, history only from install day, and a schema the community is drifting
away from. It also means running four more Tautulli containers. Rejected.

### B. Poll `/status/sessions` and rebuild Tautulli's session tracker

Gives partial plays, players and transcode decisions, which the history endpoint cannot. It is also
where Tautulli's bugs live: dropped stop events, invented durations, and a blank slate before the
collector first ran. Nothing the page has to answer needs it. Deferred, not rejected: the schema
keeps a `source` column so a session-derived row can join the ledger later.

### C. Plex's own history ledger as the backbone, enriched from metadata (recommended)

Backfill a year (configurable) from `/status/sessions/history/all` on every server, keep polling it
incrementally with an overlap so downtime loses nothing, join each play to its item's metadata for
titles and quality, and take a periodic inventory of every section for never-played. Every write is
idempotent on the server's own history id, so a crash mid-page is a retry, never a duplicate.

What this improves over Tautulli, concretely:

1. History exists the moment the collector first runs, a year deep, instead of from install day.
2. A collector outage is a delay, not a hole: the next pass re-reads the overlap window and inserts
   what it missed.
3. One store and one page for five servers, with the owner and each shared account merged across
   servers by plex.tv id.
4. Quality is the item's source resolution from metadata, so it exists for backfilled plays too.
5. Never-played is a real inventory diff, not the owner's own watched flags.

What it gives up: partial plays, which player, and whether the play transcoded. Stated on the page
as "completed plays" so nobody reads the count as sessions.

## Architecture

### Where it lives

`apps/fleet-monitor`. It already holds the five hosts, `httpx`, a SQLite file shared by the API
container and the collector container, Supabase-gated routes, and the portal already calls it
through `VITE_FLEET_BASE`. No new service, no new container, no new portal env var.

### Layers

```
fleet_monitor/
├── config.py            Host gains plex_url; plex_token(), PLEX_* intervals, lookback
├── transport/http.py    get_json gains verify=; nothing else changes
├── probes/plex.py       pure parsers: history rows, items, accounts, devices, sections,
│                        the server root, and quality_bucket(); no I/O, no clock
├── plays.py             schema, upserts, cursors, and every aggregate the API serves;
│                        every function takes a connection
├── plex_sync.py         the I/O loop: fetch + page + enrich + inventory, per host
├── collector.py         init_db creates the plex tables; __main__ runs both loops
└── api.py               /plays/* routes, gated by require_admin
```

Probes are pure and take decoded JSON. `plex_sync` is the only module that knows a URL. `plays`
is the only module that knows SQL. `api` composes views from `plays` and never touches the wire.

### Data model

All tables are prefixed `plex_` and keyed by `host` (the config name) so one file serves the fleet.

```
plex_servers   host PK, friendly_name, machine_id, version, history_cursor (epoch),
               history_synced_at, history_ok, library_synced_at, library_ok, last_error
plex_accounts  (host, account_id) PK, name, thumb
plex_devices   (host, device_id) PK, name, platform, client_identifier
plex_sections  (host, section_id) PK, title, kind ('movie' | 'episode' | 'track')
plex_items     (host, rating_key) PK, kind, title, parent_rating_key, parent_title,
               parent_index, grandparent_rating_key, grandparent_title, item_index, year,
               section_id, duration_ms, video_resolution, width, height, quality,
               thumb, added_at, present (1 while the inventory still sees it), seen_at
plex_plays     (host, history_id) PK, rating_key, kind, title, section_id, account_id,
               device_id, viewed_at (epoch), source ('history')
```

Indexes: `plex_plays (viewed_at)`, `plex_plays (host, rating_key)`, `plex_plays (account_id)`,
`plex_items (host, kind, present)`.

`quality` is one of `4k`, `1080p`, `720p`, `sd`, or NULL. NULL means no video (a track) or no
media block (an item the inventory has not reached yet, or one deleted since it was played). The
API folds `sd` and NULL video into `other`; tracks have no quality at all.

`quality_bucket` reads `videoResolution` first (`4k`; `1080`, `1080p`, `1080i`; `720`, `720p`;
`sd`, `480`, `576`) and falls back to width (3,000 and up is 4K, 1,700 is 1080p, 1,200 is 720p,
anything positive is sd). Width rather than height, because a letterboxed 1080p file reports a
height of 796.

### Grouping rule

Movies group by (title, year), episodes by show, tracks by album, on every ranked view and on
never-played. The same film on two servers is one row listing both servers; a show is one row
however many servers hold it.

Rewatches are counted per viewer per item: a viewer who watched ten different episodes of a show
has rewatched nothing, and one who watched the same episode three times has rewatched it twice.
`rewatches = sum over (viewer, item) of (plays - 1)`.

One viewing is one play, however many history rows Plex wrote for it. The server logs a row each
time an item is marked watched, and some clients (iOS and tvOS above all) mark a single viewing
twice, at the watched threshold and again at the stop; measured 2026-09-19, 222 of 6,253 rows
fleet-wide were a second marking of a viewing already logged, half of them a minute or less
after the first. Every read collapses a completion that lands sooner after the same viewer's
previous completion of the same item, on the same server, than the item runs for: the earlier
row is kept, since it is when the item became watched. An item with no known runtime keeps every
row. The ledger itself is never deduplicated, so the rule can change without a resync, and the
sync line counts through the same rule so its figure matches the overview.

### Sync design

Two cadences per host, both in `plex_sync.run_forever`, which `collector.__main__` runs alongside
the vitals loop. The API container never syncs.

**History, every `PLEX_HISTORY_INTERVAL` (300s):**

1. `GET /` for the server's name, machine id and version. A failure here records the check
   `plex:<host>` as failed with the transport reason and ends the pass for that host.
2. `GET /accounts` and `GET /devices`, upserted. Best effort: a failure logs and continues.
3. `since = cursor - overlap` when a cursor exists, else `now - lookback`. Page
   `/status/sessions/history/all?sort=viewedAt:asc&viewedAt>=since` 500 rows at a time. Each page
   is one session: insert-or-ignore the plays, advance the cursor to the page's newest `viewedAt`.
   A crash between pages resumes from the cursor.
4. Enrich: every `rating_key` in `plex_plays` with no `plex_items` row is fetched through
   `/library/metadata/{k1,...,k50}`. Keys the server answers are upserted as present; keys it does
   not answer get a stub row (`present = 0`, the play's own title) so they are not asked for
   forever.
5. Record `plex:<host>` ok, stamp `history_synced_at`.

The overlap is two days. Idempotence is by `(host, history_id)`, so re-reading it is free.

**Inventory, every `PLEX_LIBRARY_INTERVAL` (6h), first at startup:**

1. `GET /library/sections`, upsert the movie, show and artist sections.
2. For each, page `/library/sections/{id}/all?type=<leaf>&includeGuids=0` 1,000 rows at a time,
   upserting items as present with `seen_at = run stamp`, one session per page.
3. Only if every section paged to the end: mark items on that host with `seen_at` older than the
   run stamp as `present = 0`. A partial run retires nothing, so a section that failed mid-page
   cannot make its whole library look deleted.

Both passes fan out across hosts concurrently and run sequentially within a host, so five servers
cost five sockets, not fifty.

### Checks and incidents

Each history pass records one `CheckResult` for `plex:<host>`, with `gap` set to three intervals
so the five-minute cadence keeps a streak. A server that refuses or times out opens an incident on
the Fleet page's open-incidents list, which is the first time Plex being down is visible anywhere.

### API

Every route is gated by `require_admin`. Common query parameters: `days` (default 365, 0 means all
time), `host` (a config host name), `kind` (`movie` | `episode` | `track`), `quality`
(`4k` | `1080p` | `720p` | `other`). A quality filter applies to video only, so it excludes tracks.
Unknown hosts are a 422.

```
GET /plays/overview
{
  "window":     {"days": 365, "since": iso|null, "host": str|null, "kind": str|null, "quality": str|null},
  "totals":     {"plays": int, "viewers": int, "titles": int, "watch_ms": int},
  "by_kind":    [{"kind": "movie"|"episode"|"track", "plays": int}]            all three, zero-filled
  "by_quality": [{"quality": "4k"|"1080p"|"720p"|"other", "plays": int}]     video plays only, zero-filled
  "by_host":    [{"host": str, "friendly_name": str|null, "plays": int}]     every Plex host, config order
  "timeline":   {"bucket": "day"|"week"|"month", "points": [{"start": "YYYY-MM-DD", "plays": int, "hosts": {host: int}}]}
  "top_viewers": [{"account_id": int, "name": str, "plays": int}]            five
  "top_titles":  [TopTitle]                                                  five, by plays
}

GET /plays/users
{"users": [{"account_id": int, "name": str, "thumb": str|null, "plays": int, "movies": int,
            "episodes": int, "tracks": int, "hosts": [str], "last_viewed_at": iso|null,
            "top_title": str|null}]}                                          by plays desc

GET /plays/users/{account_id}/history?page=1&page_size=50
{"account_id": int, "name": str, "total": int, "page": int, "page_size": int,
 "rows": [{"viewed_at": iso, "host": str, "kind": str, "title": str, "parent_title": str|null,
           "grandparent_title": str|null, "index": int|null, "parent_index": int|null,
           "year": int|null, "quality": str|null, "device": str|null, "library": str|null,
           "duration_ms": int|null}]}

GET /plays/top?metric=plays|rewatches&limit=25
{"metric": str, "titles": [TopTitle]}
TopTitle = {"key": str, "kind": "movie"|"episode"|"track", "title": str, "context": str|null,
            "year": int|null, "quality": str|null, "plays": int, "viewers": int, "items": int,
            "rewatches": int, "top_rewatcher": {"account_id": int, "name": str, "plays": int}|null,
            "last_viewed_at": iso, "hosts": [str], "thumb": str|null}
  movie: title, year, context null. episode: title = show, context null. track: title = album,
  context = artist. items = distinct episodes or tracks played. metric=rewatches omits rows with none.

GET /plays/never-played?page=1&page_size=50&q=
{"summary": {"movies": int, "shows": int, "albums": int,
             "by_quality": [{"quality": str, "count": int}],                  movies only
             "by_host": [{"host": str, "count": int}]},
 "total": int, "page": int, "page_size": int,
 "rows": [{"key": str, "host": str, "kind": "movie"|"show"|"album", "title": str,
           "context": str|null, "year": int|null, "quality": str|null, "library": str|null,
           "added_at": iso|null, "items": int, "thumb": str|null}]}           newest added first

GET /plays/sync
{"lookback_days": int,
 "servers": [{"host": str, "friendly_name": str|null, "plex_url": str, "reachable": bool,
              "history_synced_at": iso|null, "library_synced_at": iso|null,
              "history_since": iso|null, "plays": int, "items": int, "last_error": str|null}]}
```

`days` in `/plays/never-played` means "no plays in this window"; with `days=0` it is never played
at all as far as the ledger goes. `kind` there selects movies, shows or albums.

### The page

Route `/plays`, menu label "Play history", lazily loaded like Fleet because it draws a chart.

- Header: title, then a sync line ("Synced 3 minutes ago, 5 servers, 8,341 completed plays since
  Sep 2025") and an alert when any server's last pass failed, naming the server.
- One filter toolbar above everything, outside every section so a failing query never hides the
  controls that could fix it: range (7 days, 30 days, 90 days, 1 year, All time), type (All,
  Movies, TV, Audio), quality (All, 4K, 1080p, 720p, Other), server (a select). All five persist in
  a zustand store with a validating merge, as the Fleet prefs do.
- Tabs with the ARIA tabs pattern, one panel mounted at a time so one query runs: Overview,
  Viewers, Most played, Most rewatched, Never played. The active tab persists too.
- Overview: four stat tiles (plays, viewers, titles, hours), a stacked bar timeline coloured by
  server with the fleet series palette, three breakdown lists (type, quality, server) drawn as
  labelled meters, then top viewers and top titles as short lists that jump to their tabs.
- Viewers: a table sorted by plays. Choosing a row puts `?user=<account_id>` in the URL and shows
  that viewer's paged history under a back link, so a viewer's page is shareable.
- Most played and Most rewatched: one table component, the metric as a prop.
- Never played: summary counts, a search box, a paged table sorted by date added, and the sentence
  that says what the list means ("no completed plays in the last year" or "never, as far as Plex
  remembers").
- Every section states loading, failed, or empty in words. An empty ledger on first boot says the
  collector is backfilling rather than rendering a page with nothing on it.
- Numbers are tabular mono, long titles wrap with `overflow-wrap: anywhere`, tables scroll inside
  their own scroller, nothing on the page scrolls sideways at 320px.

Server colour is by config position, the same binding Fleet uses, and every colour is paired with
the server's name in text.

### Error handling

- A host without `plex_url` is skipped everywhere, the same contract as `docker_url`.
- No token: the sync loop logs once and idles; `/plays/sync` reports every server unreachable with
  `last_error = "no_token"`, and the page says so.
- Transport failures degrade the host, never the pass: the other four keep syncing.
- Bad JSON on a page ends that host's pass with `bad_json` recorded; nothing partial is committed
  from the page that failed.
- A play whose item is gone keeps its own title and a NULL quality; the page prints it as "Other"
  and never invents a resolution.

### Testing

Backend, pytest, no network:

- `probes/plex`: table-driven parsers over literal payload dicts captured from the real servers,
  including the letterboxed 1080p case and a row missing `historyKey`.
- `plays`: writes and every aggregate against a temp file, including rewatch arithmetic, the
  grouping rule across two hosts, the quality filter excluding tracks, never-played after a retire,
  and window edges.
- `plex_sync`: `http.get_json` faked by URL; asserts cursor advance across pages, resume from a
  cursor, overlap re-read being idempotent, enrichment stubs for missing keys, inventory retire only
  on a complete run, and the `plex:<host>` check on failure.
- `api`: each route through `TestClient` with the gate overridden, plus the gate itself in
  `test_auth.GATED`.

Portal, bun test: the API module's guards and query strings, the prefs store's merge, and the page
with `fetch` stubbed by path for loading, failed, empty, loaded, tab switching, filter changes
reaching the URL, and the viewer drill-down.

## Phasing

1. Backend: config, transport, probes, store, sync, collector wiring, API, docs.
2. Portal: API module, prefs store, page, tabs, tables, chart, routing, menu.
3. Deploy: `bun run deploy:nas`, rebuild `fleet-monitor` and `fleet-collector`, watch the first
   backfill in the collector log, confirm `/plays/sync` through the Funnel.

## Out of scope

- Live sessions, partial plays, players, transcode decisions (approach B, schema-ready).
- Joining Plex accounts to Stripe members by email. Plex exposes the account name, not the email,
  on the server; that join wants plex.tv's shared-users listing and belongs to the bridge.
- Writing anything back to Plex.
- Pruning: nothing is deleted. `FM_PLEX_LOOKBACK_DAYS` bounds only how far the first backfill
  reaches.

## Known unknowns

- Whether PMS ever expires `metadata_item_views` rows on its own. Meleys holds 2,272 rows ever
  against 1,599 in the last year, which reads as no expiry, but it is not documented.
- Account id 0 appears in `/accounts` on Meleys. It is kept as-is and named by whatever the server
  calls it.
- Whether the Funnel's request size limits matter for the never-played endpoint at 50 rows a page.
  They should not; each row is a few hundred bytes.
