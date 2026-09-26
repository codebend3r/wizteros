# NestJS migration design

**Date:** 2026-09-26
**Status:** approved; Phase 0 in review (PR #57), Phases 1 to 3 not started
**Scope:** port `stripe-bridge` and `fleet-monitor` from Python 3.12 FastAPI to NestJS
(TypeScript), then remove the Python toolchain from the repo

## Problem

Two of the three apps are Python and one is TypeScript, so the repo carries two
toolchains: ruff, pytest, per-app venvs, `scripts/py-tool.sh`, the `pyToolchain` Nx
inputs, `setup-python` in CI, and a Python branch in lint-staged. Each has its own
conventions, its own caching traps (the `lint:py` flaky-cache story in `CLAUDE.md`), and its
own copy of the same code. The Supabase admin check is written twice, once per service.

The goal is one language, one lint, type and test stack, and a path to sharing types
between the portal and the services it calls.

## Non-goals

- **No behavior change.** Every route, JSON field name (snake_case), status code, env var,
  SQLite schema and background cadence stays as it is. The one deliberate exception is
  listed under Decisions.
- **No data migration.** The Nest services open the live `bridge.db` and `fleet.db` as
  they are.
- **No portal or Funnel change.** `apps/admin-portal/src/lib/{adminApi,fleetApi,playsApi}.ts`
  are the contract the new services must meet, since the portal's type guards check exact
  response shapes. The Tailscale Funnel paths (`/stripe`, `/monitor`) stay.
- **No new features** ride along with the port. Anything found worth changing gets its own
  PR after the cutover.

## What is being ported

Measured on 2026-09-26 against `main` at `8a2f29e`.

| App             | Runtime                 | Tests (`def test_`) | Moving parts                                                                                                                                             |
| --------------- | ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe-bridge` | ~3.4k lines, 17 modules | 321                 | Stripe webhook (raw body plus signature), 16 admin routes on two prefixes, SQLite with 9 tables, SMTP, Wizarr and plex.tv HTTP, 3 asyncio loops          |
| `fleet-monitor` | ~6.8k lines, 29 modules | 374                 | 14 GET routes, a separate collector process, `ssh` subprocess probes, Docker and Plex HTTP, SQLite in WAL shared by two processes, rollups and retention |

## Decisions

1. **Node 24 runs the servers; bun stays the package manager.** NestJS on Bun needs a
   community HTTP adapter, and Bun has an open issue where Fastify timeouts are ignored
   under Nest. A payment webhook is not the place for that. Node 24 is the active LTS and
   matches the portal's Netlify build. Netlify reads `.node-version` ahead of
   `NODE_VERSION` in `netlify.toml`, so the root `.node-version` has to stay equal to it.
   Phase 0 first pinned 22 and found this.
2. **NestJS 12, ESM, on the Fastify adapter.** The bridge app is created with
   `rawBody: true` so the webhook can verify Stripe's signature against the exact bytes.
3. **`nest build` on TypeScript 6; `typecheck` on tsgo.** The Nest CLI refuses TypeScript 7
   ("the compiler API is expected to return in 7.1"). tsgo typechecks Nest's decorators
   fine, so typecheck matches admin-portal and only the build step pins TypeScript 6. The
   Nest build also rewrites the `@/` alias to relative paths in `dist`.
4. **SQLite through `better-sqlite3`, with hand-written SQL and no ORM.** Its synchronous,
   connection-per-unit model is the one Python `sqlite3` uses. The existing DDL,
   `CREATE TABLE IF NOT EXISTS` and column backfills port line for line, so the production
   files open unchanged. An ORM would add a schema diff against those files and buy
   nothing. Version 13 ships N-API prebuilds inside the package (linux-x64 and arm64
   included), so it needs no install script and no compiler in the image.
5. **Validation with zod through Nest 12's Standard Schema support** in the route
   decorators. No class-validator and no casts, which fits the house TypeScript rules.
6. **Tests on Vitest.** It is the Nest 12 default for ESM and reads the decorator metadata
   without a plugin. HTTP mocks move from `responses` to `msw`, route tests use
   `@nestjs/testing` with Fastify `inject`, and each test gets a temp SQLite file, as
   `tmp_path` gives the Python suites today.
7. **One shared lib, `libs/server-common` (`@wizteros/server-common`).** It holds only what
   both servers already need:
   - `SupabaseAdminGuard` and `AdminAuthModule`: ES256 against the project's JWKS, audience
     `authenticated`, issuer `{url}/auth/v1`, a case-insensitive email allowlist, and a 401
     with body `{"detail": "unauthorized"}` on every failure path, unset config included.
   - The env parsing both servers repeat: `requireEnv`, list and allowlist parsing, and
     trailing-slash trimming.
   - `withSqlite`: one connection per unit of work, committed on return, rolled back on a
     throw, and always closed. An optional WAL mode adds a 30 second busy timeout for the
     monitor's two-process file.

   Anything else moves into the lib only once a second server needs it.

8. **The apps consume the lib's built `dist`.** Its `exports` point at `dist`, so Nx makes
   `typecheck`, `test` and `build` depend on `^build`. The lib imports same-directory `./`
   only: an app compiling against lib source would resolve the lib's `@/` to the app's own
   `src`. `@nestjs/common` is a peer dependency, so an app and the lib share one physical
   copy. Two copies would make the guard's `UnauthorizedException` fail Nest's
   `instanceof HttpException` check and turn every 401 into a 500.
9. **The new apps are built beside the old ones.** They live at `apps/fleet-monitor-nest`
   and `apps/stripe-bridge-nest`, and take over the original directory names in Phase 3.
10. **Images build from the repo root.** A `Dockerfile.dockerignore` next to each Dockerfile
    allowlists the root manifests, the lib and that one app, which keeps `.env`, the live
    data directories and every other app out of the build context. Each build installs Bun
    from the root `packageManager` value, so the Dockerfiles carry no copy of the pin. A
    production-only filtered install keeps the runtime image to that app, the lib and
    their dependencies (61 MB under `/repo` for the skeleton).
11. **The monitor ports first, the bridge second.** The monitor's API is read-only and
    nothing is lost if it is down for an hour, which makes it the place to prove the whole
    stack on the NAS. The bridge moves money and access, so it goes second, on a proven
    template.
12. **House conventions apply unchanged.** Named exports, `type` aliases, no `any`, no
    casts (request bodies and SQLite rows are narrowed with type guards), array methods
    instead of `for...of`, and single object parameters. Each project carries the
    admin-portal oxlint "Conventions from CLAUDE.md" block. The one addition is
    `typescript/no-extraneous-class` with `allowWithDecorator`, because a Nest module is a
    decorated class that is empty or holds only a static `forRoot`.
13. **The one deliberate behavior change: the bridge reads its admin auth config per
    request.** The Python bridge read `SUPABASE_URL` and `ADMIN_ALLOWED_EMAILS` once at
    import. The shared guard reads them on every request, as the Python monitor already
    does. A container that starts before its env is complete now recovers without a
    restart. Nothing that works today changes.

### Library map

| Python                     | Node                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `stripe`                   | `stripe`, with `apiVersion` pinned to the account's current version                                       |
| `requests`, `httpx`        | native `fetch`; an undici `Agent` with `rejectUnauthorized: false` only for the two plex.direct LAN hosts |
| `smtplib`                  | `nodemailer`, STARTTLS on 587                                                                             |
| plex.tv XML                | `fast-xml-parser`                                                                                         |
| `PyJWT` with `PyJWKClient` | `jose` (`createRemoteJWKSet`, `jwtVerify`), already in the lib                                            |
| asyncio loops              | `@nestjs/schedule`: `@Interval` for the loops, and a cron at `BASELINE_ROTATE_HOUR` for the rotation      |
| `ssh` subprocess           | `node:child_process` `spawn('ssh', ...)` with the same `-o` flags, ControlMaster and stdin script         |

## Contract details the port must keep

- **Error bodies.** FastAPI answers every error as `{"detail": ...}`, and the portal shows
  that text to the admin (`adminApi.ts`, "The bridge reports failures as
  {"detail": "..."}"). The guard already keeps the 401. Phase 1 adds a shared exception
  filter so a 404, a 422 and every other raised status keep the same shape.
- **Bridge paths.** Every bridge route answers both bare and under `/stripe`, because the
  Funnel strips the prefix and direct calls keep it. A test pins both.
- **CORS.** The monitor allows any origin for `GET` with `Authorization`. The bridge
  allows only `ADMIN_ALLOWED_ORIGINS`, for `GET` and `POST`, with `Authorization` and
  `Content-Type`. Both answer a preflight with 200, as Starlette did, rather than the
  plugin's default 204.
- **JSON formatting.** Python `isoformat()` timestamps and float repr differ from
  JavaScript's defaults. Serializers must reproduce the Python output, and the parity diff
  below is what proves they do.
- **Version marker.** `scripts/release.sh` hard-fails unless exactly three markers agree,
  so neither new app has a `version` field until Phase 2 moves the bridge marker.

## Phases

One branch and one PR per phase.

### Phase 0: scaffold and toolchain (branch `nestjs-scaffold`, PR #57)

- `libs/server-common` as above, with 35 tests. The guard's cases are ported from
  `fleet-monitor/tests/test_auth.py` and the `require_admin` tests in
  `stripe-bridge/tests/test_admin.py`.
- Both Nest apps as skeletons: bootstrap, CORS, the admin auth module wired, raw body on
  the bridge, and tests for the CORS behavior. They serve no product routes yet.
- A Dockerfile, a `Dockerfile.dockerignore` and a `docker-build` target per app.
- `libs/*` joins the bun workspaces, and `typecheck` and `test` depend on `^build`.
- The root oxlint and oxfmt passes ignore `libs`, which owns its config.
- CI sets up Node from `.node-version` and runs `nx run-many -t build`.
- `CLAUDE.md` documents the lib, the two ports and the import rules.

Open at the time of writing: Netlify's deploy preview fails at "Install dependencies" on
this branch (exit 1, about 9 seconds). The failure does not reproduce with Netlify's own
install script in `netlify/build:noble`, nor with clean installs on Node 22 and 24 on
arm64 and amd64. The deploy log is needed before merge, since the same failure on `main`
would stop the portal's production deploys.

### Phase 1: fleet-monitor (branch `nestjs-fleet-monitor`)

- Port module by module along the existing seams:
  1. `probes/*` first, since they are pure parsers and the easiest to pin with tests.
  2. `db`, `store`, `rollups` and `incidents`.
  3. `series` and `fleet`, including `disk_available_bytes` and `disk_mount` from #58.
  4. `plays/*`.
  5. `transport/*`, `plex_sync` and `collector`.
- The API is a Nest app on 8010. The collector is a second entrypoint in the same image
  (`NestFactory.createApplicationContext`), matching how compose runs `fleet-collector`
  from the monitor image today. The image gains `openssh-client`, `VOLUME /data` and
  `FM_DB_PATH`.
- Add the shared `{detail}` exception filter to the lib.
- **Parity:**
  - All 374 tests ported.
  - The Node API runs on 8011 against a copy of the live `fleet.db`, beside the Python API
    on 8010. A script diffs the JSON of every route across a grid of `days`, `host`, `kind`,
    `quality`, `metric`, `minutes` and `hours`. Zero differences is the bar.
- **Cutover:**
  1. Take a `nas-state-backup` snapshot of `fleet.db`.
  2. Point the `fleet-monitor` and `fleet-collector` services at the new image. The build
     context moves to the repo root; mounts, `/root/.ssh` and port 8010 stay the same.
  3. Switch the healthcheck from `python -c` to `node -e` with `fetch`.
  4. Rollback is the previous image. The schema does not change, so both run against the
     same file.

### Phase 2: stripe-bridge (branch `nestjs-stripe-bridge`)

- Port along the same module seams: `config`, `store`, `tiers`, `roster`, `invites`,
  `wizarr`, `plex`, `members`, `baseline`, `sweeps`, `alerts`, `mailer`,
  `email-template`, `snapshot`, `admin`, and the webhook handler table keyed by Stripe
  event type.
- **Webhook invariants, each pinned by its own test:**
  - The signature is checked against the raw body; a bad one is a 400.
  - `processed_events` drops duplicate deliveries.
  - An event is marked processed only after its handler succeeds, so Stripe retries a
    failure.
  - Checkout is idempotent through `session_invites`.
  - The VIP cancel guard.
  - The Wizarr library-cache guard.
- **Version marker:** `/version` reads the bridge app's `package.json`. `release.sh` moves
  its third marker there from `__init__.py`, and the `deploy-nas` and `version-bumper`
  skills follow.
- **Parity:**
  - All 321 tests ported.
  - Golden JSON for every admin GET against a copy of `bridge.db`, diffed between Python
    and Node.
  - `bun run test:e2e:tiers` (which sends signed webhooks) passes against the local Nest
    container. `test:e2e` stays blocked until the test member re-redeems an invite.
- **Cutover:**
  1. Take a `nas-state-backup` snapshot of `bridge.db`.
  2. Deploy in the 04:00 to 08:00 viewing trough.
  3. Confirm `GET /stripe/version`.
  4. Watch Stripe's webhook delivery log for an hour.
  5. Rollback is the previous image; Stripe retries anything that failed in between, and
     `processed_events` drops what already landed.
- Set `TZ` in the container so the rotation cron keeps firing at the same local hour.

### Phase 3: remove Python (branch `remove-python-backends`)

- Delete the Python apps, `scripts/py-tool.sh`, `scripts/lint-staged-py.sh`, the
  `pyToolchain` inputs, `lint:py` and `setup:py*` everywhere, `setup-python` in CI, and
  the Python entries in `.gitignore` and the deploy-script excludes.
- Rename the `-nest` apps to their original names.
- Update `CLAUDE.md`, `docs/fleet-monitor-deployment.md`, `docs/nas-deployment.md`, the
  `sanity-check.yml` image smoke test (both servers), and the skills that name Python
  paths (`deploy-nas`, `arr-stack-update`, `version-bumper`).

## Verification

- **Per project:** `test`, `lint:ts`, `format:check`, `typecheck`, `build` and
  `docker-build` pass, and the ported test count is at least the pytest count.
- **Parity:** the JSON diff shows no differences on a copy of the production database
  across every GET route and its parameter grid.
- **End to end:** the portal runs against the local Nest services (`VITE_ADMIN_API_BASE`,
  `VITE_FLEET_BASE`), covering the Members, Fleet, Plays and Income pages.
- **After each NAS cutover:** `/stripe/version` or `/monitor/health` answer, the
  `stack-health` skill is clean, and the next reconcile loop and 03:00 rotation show up in
  the logs.

## Risks

- **Stripe signatures.** Any global body parsing breaks them. Mitigated by `rawBody: true`
  and a dedicated test.
- **JSON formatting drift.** Timestamps and floats are where Python and JavaScript
  disagree. The parity diff is the check, not code review.
- **Two copies of `@nestjs/common`.** Would turn every guard 401 into a 500. Prevented by
  the peer dependency and exact version pins across the lib and both apps.
- **Effort.** About 10k runtime lines and about 700 tests. The bridge phase carries most of
  the risk, which is why it goes second.
