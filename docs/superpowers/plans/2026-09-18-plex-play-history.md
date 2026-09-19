# Plex Play History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a year or more of completed-play history from all five Plex servers in fleet-monitor's SQLite file, and add a gated `/plays` page to the admin portal that shows history by viewer, most played, most rewatched, never played, grouped by quality (4K, 1080p, 720p, other) and by type (movie, TV, audio).

**Architecture:** A second loop in the existing `fleet-collector` container pages each server's own `/status/sessions/history/all` ledger (backfill, then incremental with overlap), enriches each play from `/library/metadata` for titles and source resolution, and inventories every section for never-played. Pure parsers in `probes/plex.py`, SQL in `plays.py`, I/O in `plex_sync.py`, routes in `api.py`. The portal page reads five `/plays/*` routes through `VITE_FLEET_BASE` with TanStack Query, keeps its filters in a persisted zustand store, and draws one Recharts timeline.

**Tech Stack:** Python 3.12, FastAPI, httpx, asyncio, SQLite (stdlib, WAL), pytest, ruff. React 19, TanStack Query 5, zustand 5, Recharts 3, SCSS modules, bun test, oxlint, stylelint, tsgo.

**Spec:** `docs/superpowers/specs/2026-09-18-plex-play-history-design.md`

## Global Constraints

- **Python target is 3.12.** Ruff `select = ["E4", "E7", "E9", "F", "I", "RUF"]`; import order is enforced. Run `bunx nx run fleet-monitor:lint:py` and `bun run test:monitor`.
- **Package-absolute imports:** `from fleet_monitor import plays`, `from fleet_monitor.probes import plex`.
- **Probes are pure.** `probes/plex.py` takes decoded JSON and returns frozen dataclasses. No clock, no network, no sqlite.
- **Every store function takes a `sqlite3.Connection`**, never a path. Sessions come from `db.session(path)` only.
- **`transport.http.get_json` never raises.** Classify failures through `HttpResult.reason`; record them against the `plex:<host>` target so "not observed" never renders as healthy.
- **No `version` field and no `__version__` in fleet-monitor.** `scripts/release.sh` counts exactly three markers.
- **Dockerfile, project.json, package.json, requirements.txt, docker-compose.yml, nx.json stay untouched.** The image copies the whole package; `httpx` is already a dependency.
- **Web imports use `@/`**, never `../`. Type aliases only, no `interface`, no `any`, no non-null assertions, no casts, named exports only, `!!value` for booleans, `?.` always paired with `??`, single object parameters, `reduce`/`map`/`filter` over loops.
- **SCSS:** modules per component, `display: grid` with `gap` first (flex second), no margins for spacing, tokens from `styles/globals.scss` only, `@media (max-width: 48rem)` to stack, no horizontal page scroll at 320px in any state, `overflow-wrap: anywhere` on long strings, tables inside an `overflow-x: auto` scroller.
- **Accessibility:** semantic elements, ARIA tabs pattern for the tab strip (arrow keys wrap, one tab stop), `aria-pressed` on segmented buttons, every control labelled, `role="alert"` for failures, `aria-live="polite"` for loading text, colour always paired with text, `prefers-reduced-motion` respected.
- **Tests import from `@/test/vi`**, never `bun:test`. Page tests stub `fetch` by path and set `useAuthStore.setState({ enabled: false })`.
- **No en dashes or em dashes** anywhere.
- **Do not commit, branch, push, merge or open a PR.** CJ does that.

## Fleet reference (measured 2026-09-18)

| Host        | Plex URL                     | Notes                                |
| ----------- | ---------------------------- | ------------------------------------ |
| `meleys`    | `http://192.168.50.2:32400`  | 24 sections, 1,599 plays in the year |
| `vermithor` | `https://192.168.50.3:32400` | requires https, self-signed          |
| `caraxes`   | `http://192.168.50.4:32400`  | 6 sections, 4,109 plays in the year  |
| `syrax`     | `http://192.168.50.5:32400`  | 4 sections, 661 plays in the year    |
| `vhagar`    | `https://192.168.50.6:32400` | requires https, self-signed          |

The owner token is `PLEX_TOKEN` in the root `.env`, already passed to every compose service through `env_file`. The monitor reads `FM_PLEX_TOKEN` first and falls back to `PLEX_TOKEN`.

## File structure

```
apps/fleet-monitor/fleet_monitor/
├── config.py                 + plex_url on Host, plex_token(), PLEX_HISTORY_INTERVAL,
│                               PLEX_LIBRARY_INTERVAL, plex_lookback_days()
├── transport/http.py         + verify kwarg on get_json
├── probes/plex.py            NEW pure parsers + quality_bucket
├── plays.py                  NEW schema, writes, cursors, aggregates
├── plex_sync.py              NEW history pass, inventory pass, run_forever
├── collector.py              init_db adds plays; __main__ runs both loops
└── api.py                    + /plays/overview, /plays/users, /plays/users/{id}/history,
                                /plays/top, /plays/never-played, /plays/sync
apps/fleet-monitor/tests/
├── conftest.py               db fixture also inits plays
├── fixtures/plex_*.json      NEW captured payload shapes
├── test_probes_plex.py       NEW
├── test_plays.py             NEW
├── test_plex_sync.py         NEW
├── test_api_plays.py         NEW
├── test_auth.py              GATED gains the six routes
└── test_config.py            plex urls, token fallback, lookback

apps/admin-portal/src/
├── lib/fleetApi.ts           export requestJson
├── lib/playsApi.ts           NEW wire types, guards, fetchers, query string
├── lib/playsApi.test.ts      NEW
├── stores/playsPrefsStore.ts NEW persisted filters + tab, validating merge
├── stores/playsPrefsStore.test.ts NEW
├── pages/Plays/
│   ├── Plays.tsx             page: gate, layout, header, filters, tabs, sections
│   ├── Plays.module.scss
│   ├── Plays.test.tsx
│   ├── PlaysFilters.tsx (+ .module.scss)     range / type / quality / server
│   ├── ViewTabs.tsx (+ .module.scss)         ARIA tabs, generic over view ids
│   ├── StatTiles.tsx (+ .module.scss)
│   ├── PlaysTimeline.tsx (+ .module.scss)    Recharts stacked bars by host
│   ├── BreakdownList.tsx (+ .module.scss)    labelled meters
│   ├── ViewersPanel.tsx                      table + drill-down
│   ├── ViewerHistory.tsx                     paged history table
│   ├── TopTitlesPanel.tsx                    most played / most rewatched
│   ├── NeverPlayedPanel.tsx
│   ├── DataTable.module.scss                 shared table styles
│   ├── Pager.tsx (+ .module.scss)
│   ├── playsCopy.ts                          labels and prose
│   └── playsFormat.ts                        dates, hours, titles
├── components/Icon/Icon.tsx  + play, users, unplayed glyphs
├── AppRoutes.tsx             + lazy /plays
├── AppRoutes.test.tsx        + gate and serve tests
├── components/SideMenu/SideMenu.tsx  + { label: 'Play history', path: '/plays' }
└── lib/queryPersistence.ts   + 'plays-sync' live key

.env.example                  FM_PLEX_TOKEN (optional), FM_PLEX_LOOKBACK_DAYS
docs/fleet-monitor-deployment.md   routes, env, https note
```

## Backend

### Task 1: config and transport

- [x] `Host` gains `plex_url: str = ""`; fill the five URLs from the fleet reference with a comment on the two https hosts.
- [x] `plex_token()` reads `FM_PLEX_TOKEN`, then `PLEX_TOKEN`, else `""`.
- [x] `PLEX_HISTORY_INTERVAL = 300`, `PLEX_LIBRARY_INTERVAL = 6 * 3600`, `plex_lookback_days()` from `FM_PLEX_LOOKBACK_DAYS` default 365 (non-numeric falls back).
- [x] `get_json(..., verify: bool = True)` passes `verify` to `httpx.AsyncClient`.
- [x] Tests in `test_config.py`: every host has a Plex URL, the two https hosts, token precedence, lookback default and override.

### Task 2: probes/plex.py

- [x] Dataclasses: `PlayEntry`, `MediaItem`, `Account`, `Device`, `Section`, `ServerInfo`.
- [x] `parse_history`, `history_total`, `parse_items`, `parse_accounts`, `parse_devices`, `parse_sections`, `parse_server`, `quality_bucket`, `LEAF_TYPE` map.
- [x] Malformed rows are skipped, never raised on; a row missing `historyKey` or a non-digit `ratingKey` is skipped; only movie, episode, track survive.
- [x] Fixtures: one history page, one multi-key metadata answer (movie letterboxed 1080p, one episode, one track), one section page, accounts, devices, sections, root.
- [x] Tests table-driven per parser and per bucket rule.

### Task 3: plays.py

- [x] Schema + indexes + `init_db`.
- [x] Writes: `upsert_server`, `mark_history`, `mark_library`, `upsert_accounts`, `upsert_devices`, `upsert_sections`, `upsert_items`, `stub_missing_items`, `retire_unseen_items`, `insert_plays` (returns inserted count), `history_cursor`, `missing_item_keys`.
- [x] `Filters` dataclass (`since`, `host`, `kind`, `quality`) and one shared WHERE builder.
- [x] Reads: `overview`, `users`, `user_history`, `top_titles`, `never_played`, `sync_status`.
- [x] Tests over a temp file: idempotent inserts, cursor, rewatch arithmetic, cross-host grouping, quality filter excluding tracks, never-played after retire, window edges, pagination.

### Task 4: plex_sync.py

- [x] `fetch(host, path, *, token, params, start, size, timeout)` building headers and `verify=not https`.
- [x] `sync_history(host, path, *, now, token, lookback_days)` per the spec's five steps, one session per page, check recorded with `gap` of three intervals.
- [x] `sync_library(host, path, *, now, token)` with retire only on a complete run.
- [x] `run_forever(path)` with the two cadences, deadline-based sleeping, hosts fanned out concurrently, `_log_raised` on the gather.
- [x] Tests with `get_json` faked by URL: two-page backfill, resume from cursor, overlap idempotence, enrichment stubs, inventory retire vs partial, failure check, no token idles.

### Task 5: collector wiring and API

- [x] `collector.init_db` calls `plays.init_db`; `__main__` runs `run_forever` and `plex_sync.run_forever` under one `asyncio.gather` through a new `run_all(path)`.
- [x] `conftest.db` also inits plays.
- [x] View dataclasses and six routes in `api.py`, `Query` validation, unknown host 422, `days=0` means all time.
- [x] `test_api_plays.py` seeds through `plays` and asserts each route; `test_auth.GATED` gains all six.
- [x] `bunx nx run fleet-monitor:lint:py` and `bun run test:monitor` green.

## Portal

### Task 6: API module and prefs store

- [x] Export `requestJson` from `fleetApi.ts` (no other change there).
- [x] `playsApi.ts`: wire types matching the spec, `isX` guards from `isRecord` primitives, `playsQuery(filters)`, six fetchers, `PLAY_RANGES`, `PLAY_KINDS`, `PLAY_QUALITIES` with labels.
- [x] `playsPrefsStore.ts`: `rangeDays`, `host`, `kind`, `quality`, `tab`, each validated on set and on merge, `name: 'wz-plays-prefs'`.
- [x] Tests for guards, query strings (omits empty filters, `days=0` for all time), store merge.

### Task 7: page

- [x] `Icon.tsx` gains `play`, `users`, `unplayed` on the same 16-unit stroke grid.
- [x] `ViewTabs`, `PlaysFilters`, `StatTiles`, `BreakdownList`, `PlaysTimeline`, `Pager`, the three tables, `Plays.tsx` composing them with an `AsyncSection` for every query.
- [x] Copy in `playsCopy.ts`; formatting in `playsFormat.ts` (hours from ms, dates via `toLocaleString`, episode label `S4 E1`).
- [x] Empty ledger on first boot reads as "backfilling", not as nothing.
- [x] Tests in `Plays.test.tsx` for loading, failed, empty, loaded, tabs, filters reaching the query string, viewer drill-down via `?user=`.

### Task 8: routing and verification

- [x] `AppRoutes.tsx` lazy `/plays` with a Suspense fallback; `AppRoutes.test.tsx` gate + serve.
- [x] `SideMenu.tsx` entry after Fleet.
- [x] `queryPersistence.ts` adds `plays-sync`.
- [x] `bun run system-check:no-cache` green; `bunx nx run admin-portal:build` green.

## Docs

### Task 9

- [x] `.env.example`: `FM_PLEX_TOKEN` (optional, falls back to `PLEX_TOKEN`) and `FM_PLEX_LOOKBACK_DAYS` under the fleet-monitor block.
- [x] `docs/fleet-monitor-deployment.md`: the six routes in "What is exposed", the env, the https note, and the first-backfill expectation in "Verifying".
- [x] `README.md` skill/page listing if it enumerates admin pages.
