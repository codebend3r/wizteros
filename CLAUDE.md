# Claude context for wizteros

This file is loaded automatically when Claude Code runs inside this repo. It captures the working context that doesn't belong in the README.

## Hard rules

These override any inference from the code. Ask first, every time:

- Do not commit anything unless I tell you.
- Do not switch branches unless I tell you.
- Do not push anything unless I tell you.
- Do not merge anything unless I tell you.
- Do not create a PR unless I tell you.
- Do not create a branch unless I tell you.

## What this project is

A self-hosted stack that gates Plex access behind a recurring Stripe "server-cost contribution":

| Piece                                     | Role                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wizarr**                                | Invite-based onboarding for Plex users                                                                                                             |
| **Tautulli**                              | Usage analytics                                                                                                                                    |
| **stripe-bridge** (`apps/stripe-bridge/`) | Small NestJS service that converts Stripe webhooks (`checkout.session.completed`, `customer.subscription.deleted`) into Wizarr API calls           |
| **admin-portal** (`apps/admin-portal/`)   | Landing page plus the gated admin pages                                                                                                            |
| **fleet-monitor** (`apps/fleet-monitor/`) | NestJS service that SSH-probes the NAS fleet and serves host metrics to the admin portal's Fleet page, behind the same Supabase auth as the bridge |

The contribution framing is deliberate: Plex TOS prohibits selling access, and Stripe TOS prohibits selling rights you don't own. When suggesting copy, product descriptions, or UX text, lean toward infrastructure/hosting language. Never reference content, libraries, or titles in user-facing payment surfaces. The `copy-compliance` skill audits this.

## Structure

An Nx monorepo over bun workspaces (`workspaces: ["apps/*", "libs/*"]`), with three apps and one shared lib. The two servers are NestJS; both were FastAPI services until the migration in `docs/superpowers/specs/2026-09-26-nestjs-migration-design.md`.

```
wizteros/
├── apps/
│   ├── admin-portal/           Nx project `admin-portal`
│   │   ├── public/
│   │   └── src/                components/ pages/ lib/ stores/ styles/ test/
│   ├── fleet-monitor/          Nx project `fleet-monitor`, the API and the collector
│   │   └── src/                api/ plays/ probes/ transport/ test/, tests beside each module
│   └── stripe-bridge/          Nx project `stripe-bridge`
│       ├── src/                webhook/ admin/ clients/ test/, tests beside each module
│       └── scripts/            e2e and library snapshot entrypoints
├── libs/
│   └── server-common/          Nx project `@wizteros/server-common`, shared by the NestJS servers
├── docs/                       all specs, plans, and PRDs for both apps
├── scripts/                    release, backfill, and deploy entrypoints
├── .claude/agents/             repo-scoped subagents
├── .claude/skills/             repo-scoped skills
├── .github/                    CI workflows
├── .husky/                     pre-commit and pre-push hooks
├── docker-compose.yml          builds the bridge and the fleet monitor
├── netlify.toml                builds admin-portal, publishes apps/admin-portal/dist
├── nx.json                     target defaults, cacheable targets, named inputs
├── .oxlintrc.json              oxlint for everything outside apps/
├── .oxfmtrc.json               oxfmt for everything outside apps/
├── .lintstagedrc.json          staged-file pass for everything outside apps/
└── package.json                bun workspaces plus thin aliases that delegate to nx
```

**admin-portal**, a Vite + React SPA (TypeScript, bun). `index.html`, `vite.config.ts`, `tsconfig.json`, `bunfig.toml`, and the oxlint/oxfmt/stylelint configs live at the app root. It has no `project.json`: Nx infers targets from the `scripts` in its `package.json`, whitelisted by the `nx.includedScripts` field there. Adding a script that should be runnable as a target means adding it to that list too.

**The servers** are NestJS 12 (ESM, Fastify adapter) and run on Node 24 (`.node-version`, `node:24-slim` images; Netlify reads the same file, so it has to match `NODE_VERSION` in `netlify.toml`), with bun still the package manager. `build` is `nest build` on TypeScript 6, because the Nest CLI needs the compiler API that TypeScript 7 does not ship yet; `typecheck` is tsgo, as in admin-portal. Tests are Vitest. `docker-compose.yml` builds `stripe-bridge` from `apps/stripe-bridge`, and `fleet-monitor` and `fleet-collector` from `apps/fleet-monitor` (the collector is `node dist/collectorMain.js`). Each image builds from the repo root context, and the `Dockerfile.dockerignore` next to each Dockerfile allowlists what goes in, which keeps `.env` and the live data out. Both still answer exactly as the FastAPI services did (snake_case fields, `{"detail": ...}` errors, Pydantic's timestamps), because the portal's type guards were written against that wire; comments that cite "the Python" explain why a behaviour is kept.

**stripe-bridge**: every module that reads the store or talks to Wizarr, Stripe, plex.tv or SMTP takes the port it needs from a `Bridge` (`types.ts`: the store, the four service ports, and settings) rather than importing a client, which is what lets a test hand in the fakes in `src/test/fakes.ts`. `bridgeFromEnv.ts` builds the real one and `BridgeModule` provides it app-wide. The store (`store/`) is one module per group of tables, each a factory over a pair of connection units; `openStore(path)` gives every call its own connection, and `store.transaction` runs several on one. The webhook lives in `webhook/` (`handlers.ts` is the handler table keyed by Stripe event type), the admin routes in `admin/` (`adminController.ts` is decorators and body parsing; `actions.ts` and `queries.ts` hold what each route does), the background jobs in `loops.ts` (their alarms in `changeAlert.ts`), every env read in `config.ts`, and the service clients in `clients/`. `invites.ts` is the one place an invite is scoped, minted and recorded. `tiers.ts` owns the `Tier` type and the one rule table behind every tier (what it shares, from where, whether it downloads), `standing.ts` owns `MemberTag` and what a tag means (`isBanned`, `holdsStandingGrant`, `isTimeBoxed`), and `subscriptionStatus.ts` owns what a Stripe status means; nothing else compares a tier, tag or status string. Service calls in a loop go through `eachInOrder`/`mapInOrder` (`sequence.ts`), because the Python made them one at a time and tests assert the order.

**fleet-monitor**: `api/` is routes and view models only; the fleet judgement behind them lives in `fleet.ts` and the metric history in `series.ts`. `plays/` holds the play-history ledger (`ledger.ts`), its aggregates (`views.ts`) and the unplayed engine (`neverPlayed.ts`). `pythonMath.ts` reproduces the Python rounding and division the numbers were first computed with, so the port's figures match.

**server-common** (`libs/server-common`, `@wizteros/server-common`): `SupabaseAdminGuard` and `AdminAuthModule`, the env parsing both servers share, `withSqlite`, the one-connection-per-unit-of-work helper, the SQLite row guards (`rows.ts`), Python's `isoformat()` and its parsing (`time.ts`), and `fastApiValidationPipe`, FastAPI's 422 for a failed query or body schema. Apps consume its built `dist`, which is why `typecheck`, `test` and `build` all depend on `^build`. Its `@nestjs/common` is a peer dependency, so an app and the lib share one copy and the guard's 401 stays an `HttpException` to the app.

Import rules, which tooling does not catch:

- NestJS server modules import via the `@/` alias with a `.js` extension (`@/config.js`), since they compile as nodenext ESM; `nest build` rewrites the alias to a relative path in `dist`. The shared lib imports same-directory `./` only, because an app compiling against it would resolve its `@/` to the app's own `src`.
- Web modules import via the `@/` alias, never parent-relative `../`. Same-directory `./` imports (co-located styles, tests) are fine. The alias maps to `apps/admin-portal/src/*` and is declared in both `apps/admin-portal/tsconfig.json` and `apps/admin-portal/vite.config.ts`, so a new alias must be added in both.
- Unqualified paths below (`styles/globals.scss`, `lib/foo.ts`) are relative to `apps/admin-portal/src/`.

## Nx and tasks

Run tasks through Nx, not by cd-ing into an app:

```bash
bunx nx run admin-portal:test          # one target, one project
bunx nx run-many -t lint:ts test       # a target everywhere it exists
bunx nx affected -t test               # only what the branch changed
bunx nx show project stripe-bridge     # a project's real target list
```

The root `bun run <script>` aliases (`dev`, `build`, `verify`, `system-check`, `lint`, `test:web`, `test:bridge`, `bridge:*`, `release:*`, `deploy:nas`) are kept for muscle memory and all delegate to Nx.

`bun run system-check:no-cache` is `system-check` plus `--skip-nx-cache`: the same five admin-portal targets, but every one actually executes instead of reporting a cache hit. Use it to confirm a cached green is real.

Most projects source targets from more than one place, so check `nx show project` rather than assuming from a single file:

| Project                   | Targets come from                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-portal`            | `package.json` scripts only, gated by `nx.includedScripts`                                                                                                                                                                                                                        |
| `fleet-monitor`           | `package.json` scripts (`build`, `typecheck`, `lint:ts`, `format:check`, `test`) gated by `nx.includedScripts`, plus `project.json` for `docker-build`                                                                                                                            |
| `stripe-bridge`           | `package.json` scripts (the same five, plus `test:e2e`, `test:e2e:tiers`, `refresh:libraries`) gated by `nx.includedScripts`, **plus** `project.json` for the Docker targets (`docker-build`, `serve`, `stop`, `logs`), declared as `nx:run-commands` with `cwd: {workspaceRoot}` |
| `@wizteros/server-common` | `package.json` scripts only, gated by `nx.includedScripts`                                                                                                                                                                                                                        |

Anything cacheable is declared in `nx.json` `targetDefaults`. A new target that is safe to cache belongs there; anything that touches Docker or the network must stay `cache: false`.

A cacheable target has to declare every input that can change its result, including the tool that runs it. A tool installed outside `{projectRoot}` (a venv, a global binary) is invisible to the `{projectRoot}/**/*` file glob, so a missing or upgraded one flips the outcome under an identical hash, which Nx reports as a flaky task; that is what the Python linter did here. Every tool the gates run today is a pinned devDependency in `bun.lock`, which the default inputs already cover.

Bun itself is pinned. `packageManager` in the root `package.json` is the source of truth: CI picks it up through `oven-sh/setup-bun` (no `bun-version` input on purpose), `netlify.toml` mirrors it as `BUN_VERSION`, and `scripts/only-bun.mjs` fails any script run under a different Bun, on top of rejecting npm/pnpm/yarn outright. Moving the pin means moving both files in the same commit. The NestJS Dockerfiles install Bun from that same `packageManager` value at build time, so they carry no copy of the pin.

`trustedDependencies` in the root `package.json` is the list of packages whose install scripts Bun runs, and setting it replaces Bun's built-in default list. It names `nx` and `@parcel/watcher`, the two that ran before, and deliberately leaves out `better-sqlite3`. That package ships N-API prebuilds and marks itself `"gypfile": false`, but Bun 1.4 ignores the flag and runs `node-gyp rebuild` because a `binding.gyp` is present. Netlify has no `node-gyp`, so that one script failed every deploy at "Install dependencies". A new dependency that genuinely needs its install script has to be added to the list; `bun pm untrusted` shows any that were skipped.

Gates: pre-commit runs `bun run lint:staged` (lint-staged, autofixing just the staged files) then `bun run system-check` (admin-portal only), pre-push runs `bun run verify` (every project). CI runs the same checks. lint-staged config is per app in `apps/*/.lintstagedrc.json`, and commands there must spell out `node_modules/.bin/<tool>` because bun keeps the bins in the app, not the root.

## Releases and deploy

Three version markers move in lockstep: root `package.json`, `apps/admin-portal/package.json`, and `apps/stripe-bridge/package.json`. The bridge marker is the only one that reaches the container, and it is what `GET /version` reports.

- Never hand-edit a version field. `scripts/release.sh` owns the flow and hard-fails when the three disagree. The `version-bumper` skill decides whether a bump is due.
- Every release gets a `CHANGELOG.md` section.
- `admin-portal` redeploys from `main` via Netlify on its own. **The NAS does not.** A release touching the bridge needs `bun run deploy:nas` (or the `deploy-nas` skill) afterwards, then confirm with `GET /version`.

## Lint and enforcement

The repo does have linters: oxlint for TS/JS, stylelint for SCSS, oxfmt for formatting, tsgo for type checking.

Several conventions below are enforced as lint errors, not just style preferences, in `apps/admin-portal/.oxlintrc.json` under a block marked "Conventions from CLAUDE.md": no default exports, `type` over `interface`, no `any`, no non-null assertions, `eqeqeq`, `prefer-const`, `prefer-array-flat-map`. Turning one of these off to make code pass is not the fix.

There is a second oxlint and oxfmt pair at the repo root, `.oxlintrc.json` and `.oxfmtrc.json`, covering everything outside `apps/`: the `.mjs` tooling under `scripts/` and `.claude/skills/**`, the docs, and the root config files. It ignores `apps` and `libs` outright, since each project owns its own config, and it is a plain script rather than an Nx target because the repo root is not an Nx project. The oxfmt pass runs with `--disable-nested-config`: without it oxfmt discovers `apps/admin-portal/.oxfmtrc.json`, treats that app as its own formatting root, and formats its files under the root pass regardless of the ignore list. `bun run lint`, `format`, `format:check` and `verify` run it first and then fan out to the projects; `bun run lint:root`, `lint:root:fix`, `format:root` and `format:check:root` run only that pass. The root config disables four rules whose suggested fix contradicts the house style (`for…of` over `forEach`, mutating a `reduce` accumulator, mutating a mapped object, `toSorted` on an array that is already a fresh copy); each carries a comment saying so.

Everything else here is convention, and the import-alias rule in particular has no lint rule behind it.

## React

- Never use default exports if it can be avoided, prefer named exports
- Always import all React methods, constants, and types from `react`, e.g. `import { useState } from 'react'`
- Prefer using latest features in React when possible
- Prefer using the `use` hook pattern for state management
- Prefer using zustand always for global state management

## Typescript

- Always use type aliases. Never use TypeScript interfaces anywhere, including `declare global` augmentations
- Use type guards wherever possible.
- Never use `any` types; prefer type narrowing or type guards
- Never under any circumstance cast types and never double cast: `as any as string`
- If type can't be inferred and type narrowing is not an option, use `unknown` types

## Servers

- Tests sit beside the module they cover as `*.test.ts`, with shared fakes and fixtures under `src/test/`. Run them with `bun run test:bridge` and `bun run test:monitor`
- Every SQLite read narrows its rows with the guards in `@wizteros/server-common` (`asRow`, `fields`), never a cast
- A new environment variable is read in the app's `config.ts`, when it is asked for, never captured at import

## CSS

- Use SCSS modules (`*.module.scss`) for component styles
- Only use global stylesheets (`styles/globals.scss`) for design tokens and true typographic primitives
- Use a container driven approach, meaning the container will define the width and height and the children will be positioned within it, this means if/when the children are moved to different containers they may be laid out differently depending on what the container specifies
- Prefer using CSS display grid for layout with the gap property for spacing between grid items; avoid using margins for spacing
- Second preferred display value is flex
- Avoid using plain divs, meaning divs with no class or id defined
- Always use token values from `styles/globals.scss` when defining font sizes, colors, and other design tokens like padding, margin, gap, and border radius
- Responsive design is a must: every page must render without horizontal page scroll down to a 320px viewport, in every state (loaded, loading, error, empty)
- Wide content (tables, long emails/ids) scrolls inside its own `overflow-x: auto` container or wraps (`overflow-wrap: anywhere`, `flex-wrap: wrap`); the page itself never scrolls sideways. Watch grid/flex min-content traps: single-column page grids use `grid-template-columns: minmax(0, 1fr)`, and note `overflow-wrap: break-word` does not shrink min-content while `anywhere` does
- Use `48rem` as the mobile breakpoint (`@media (max-width: 48rem)`) to stack side-by-side headers/columns, matching the admin sidebar collapse; `40rem`/`64rem` are the landing-page column steps

## Code style

- Always prefer immutable data structures and operations
- Prefer `reduce` over `for` loops when possible. Never use `for/in` or `for/of` loops; reach for `Array.prototype` methods (`map`, `filter`, `reduce`, `flatMap`, etc.) when the value is an array.
- Prefer double-bang (`!!value`) for boolean conversion.
- Prefer short-circuit (`&&`) over a ternary when the else branch is `null` or `undefined`, especially in React rendering. Do: `{isActive && <Badge />}`. Don't: `{isActive ? <Badge /> : null}`. Guard the condition so it is a real boolean (`!!count && ...`), never a bare number that could render `0`.
- Prefer optional chaining (`?.`). When optional chaining is used, ALWAYS pair it with nullish coalescing (`??`) to supply a fallback.
- Prefer a single configurable object parameter over multiple positional parameters so argument order doesn't matter. Don't: `doSomething(foo, bar, hello)`. Do: `doSomething({ foo, bar, hello })`.

## Accessibility

- Use best practices for accessibility
- Use semantic HTML elements (`button`, `nav`, `main`, `header`, `ul`/`li`, `label`) before reaching for a generic element with a role; a native `button` beats a `div` with `onClick`
- Every interactive element must be reachable and operable by keyboard alone; preserve a logical tab order and never remove focus outlines without providing an equally visible `:focus-visible` style
- Associate every form control with a `label` (via `htmlFor`/`id` or wrapping); use `aria-describedby` for hints and error text
- Provide accessible names for icon-only controls with `aria-label`; mark purely decorative icons/images `aria-hidden="true"` and give meaningful images real `alt` text (empty `alt=""` when decorative)
- Add ARIA only to fill gaps native semantics can't; never override a native role, and prefer no ARIA over wrong ARIA
- Announce dynamic changes (toasts, async status, form errors) with an appropriate `aria-live` region or `role="alert"`
- Manage focus for modals, drawers, and menus: move focus in on open, trap it while open, restore it to the trigger on close, and close on `Escape`
- Meet WCAG AA contrast (4.5:1 body text, 3:1 large text and UI/graphical elements); verify against `styles/globals.scss` color tokens
- Respect `prefers-reduced-motion` and gate non-essential animation/transitions behind it
- Never convey meaning by color alone; pair it with text, an icon, or another cue
- Use relative units (`rem`) so the UI scales with user font-size settings, and keep layouts usable at 200% zoom
- Set a correct `lang` on the document and keep a single, ordered heading hierarchy (one `h1`, no skipped levels)

## Commits

- Create a commit after every logical change, batch if they are related.
- Subject must start with `WZ:` followed by a short title (e.g., `WZ: a short title`).
- Favor bullet points in the body. Keep it concise and easy to read.

## Pull Requests

- Should follow the same naming convention as commits and every PR title should start with `WZ: a short title`
- The body of the PR should be minimal and favour bullet points

## Skills

Repo-scoped skills live in `.claude/skills/`. Prefer them over improvising: `commiter` and `pr-creator` for the conventions above, `version-bumper` and `deploy-nas` for shipping, `nas-state-backup` before touching live NAS state, `copy-compliance` for user-facing copy, `monitor-ci` for CI. The README lists all of them.

Repo-scoped subagents live in `.claude/agents/`: `wizteros-reviewer` reviews a diff, branch, or PR against the conventions here that the toolchain does not enforce.
