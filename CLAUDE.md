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

| Piece                                     | Role                                                                                                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wizarr**                                | Invite-based onboarding for Plex users                                                                                                              |
| **Tautulli**                              | Usage analytics                                                                                                                                     |
| **stripe-bridge** (`apps/stripe-bridge/`) | Small FastAPI service that converts Stripe webhooks (`checkout.session.completed`, `customer.subscription.deleted`) into Wizarr API calls           |
| **admin-portal** (`apps/admin-portal/`)   | Landing page plus the gated admin pages                                                                                                             |
| **fleet-monitor** (`apps/fleet-monitor/`) | FastAPI service that SSH-probes the NAS fleet and serves host metrics to the admin portal's Fleet page, behind the same Supabase auth as the bridge |

The contribution framing is deliberate: Plex TOS prohibits selling access, and Stripe TOS prohibits selling rights you don't own. When suggesting copy, product descriptions, or UX text, lean toward infrastructure/hosting language. Never reference content, libraries, or titles in user-facing payment surfaces. The `copy-compliance` skill audits this.

## Structure

An Nx monorepo over bun workspaces (`workspaces: ["apps/*"]`), with three apps and no shared libs yet.

```
wizteros/
├── apps/
│   ├── admin-portal/           Nx project `admin-portal`
│   │   ├── public/
│   │   └── src/                components/ pages/ lib/ stores/ styles/ test/
│   ├── fleet-monitor/          Nx project `fleet-monitor`
│   │   ├── fleet_monitor/      all runtime code
│   │   ├── scripts/            lint and test entrypoints
│   │   └── tests/              pytest suite
│   └── stripe-bridge/          Nx project `stripe-bridge`
│       ├── stripe_bridge/      all runtime code
│       ├── scripts/            lint, test, and e2e entrypoints
│       └── tests/              pytest suite
├── docs/                       all specs, plans, and PRDs for both apps
├── scripts/                    release, backfill, and deploy entrypoints
├── .claude/agents/             repo-scoped subagents
├── .claude/skills/             repo-scoped skills
├── .github/                    CI workflows
├── .husky/                     pre-commit and pre-push hooks
├── docker-compose.yml          builds ./apps/stripe-bridge, bridge only
├── netlify.toml                builds admin-portal, publishes apps/admin-portal/dist
├── nx.json                     target defaults, cacheable targets, named inputs
├── .oxlintrc.json              oxlint for everything outside apps/
├── .oxfmtrc.json               oxfmt for everything outside apps/
├── .lintstagedrc.json          staged-file pass for everything outside apps/
└── package.json                bun workspaces plus thin aliases that delegate to nx
```

**admin-portal**, a Vite + React SPA (TypeScript, bun). `index.html`, `vite.config.ts`, `tsconfig.json`, `bunfig.toml`, and the oxlint/oxfmt/stylelint configs live at the app root. It has no `project.json`: Nx infers targets from the `scripts` in its `package.json`, whitelisted by the `nx.includedScripts` field there. Adding a script that should be runnable as a target means adding it to that list too.

**stripe-bridge**, a FastAPI service (Python 3.12). All runtime code lives in the `stripe_bridge/` package: `stripe_wizarr_bridge.py` is the app entrypoint, plus `wizarr.py`, `plex.py`, `store.py`, `tiers.py`, `mailer.py`, `email_template.py`, `admin.py`, `snapshot.py`. Everything else (`tests/`, `scripts/`, `Dockerfile`, `pytest.ini`, `ruff.toml`, `requirements*.txt`, `package.json`, `project.json`) sits at the app root, outside the package.

Import rules, which tooling does not catch:

- Bridge modules import package-absolute: `from stripe_bridge import store`, `from stripe_bridge.wizarr import WizarrClient`. New modules go inside `stripe_bridge/` and need no Dockerfile change, since the image copies the whole package. fleet-monitor follows the same rule with its `fleet_monitor/` package.
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

All three projects source targets from more than one place, so check `nx show project` rather than assuming from a single file:

| Project         | Targets come from                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-portal`  | `package.json` scripts only, gated by `nx.includedScripts`                                                                                                                                                                                                                                      |
| `fleet-monitor` | `package.json` scripts (`test`, `lint:py`) gated by `nx.includedScripts`, plus `project.json` for `docker-build`                                                                                                                                                                                |
| `stripe-bridge` | `package.json` scripts (`test`, `lint:py`, `test:e2e`, `test:e2e:tiers`, `refresh:libraries`) gated by `nx.includedScripts`, **plus** `project.json` for the Docker targets (`docker-build`, `serve`, `stop`, `logs`, `test-docker`), declared as `nx:run-commands` with `cwd: {workspaceRoot}` |

Anything cacheable is declared in `nx.json` `targetDefaults`. A new target that is safe to cache belongs there; anything that touches Docker or the network must stay `cache: false`.

A cacheable target has to declare every input that can change its result, including the tool that runs it. `lint:py` is the one that bites: ruff lives in each app's gitignored `.venv`, so it is invisible to the `{projectRoot}/**/*` file glob, and a missing or upgraded ruff used to flip the outcome under an identical hash, which is what Nx reported as a flaky task. Each Python project therefore defines a `pyToolchain` named input in its own `project.json`, a `runtime` command that prints the resolved ruff version (or `ruff missing`), and `targetDefaults.lint:py` composes it as `["default", "pyToolchain"]`. Two constraints forced that shape: `{projectRoot}` is **not** interpolated inside a `runtime` input, so the venv path has to be spelled out per project rather than shared in `nx.json`, and runtime commands run from the workspace root, so the path is workspace-relative. Ruff is pinned in both `requirements-dev.txt` so the version cannot drift underneath the pin.

Gates: pre-commit runs `bun run lint:staged` (lint-staged, autofixing just the staged files) then `bun run system-check` (admin-portal only), pre-push runs `bun run verify` (both apps). CI runs the same checks. lint-staged config is per app in `apps/*/.lintstagedrc.json`, and commands there must spell out `node_modules/.bin/<tool>` because bun keeps the bins in the app, not the root.

## Releases and deploy

Three version markers move in lockstep: root `package.json`, `apps/admin-portal/package.json`, and `__version__` in `apps/stripe-bridge/stripe_bridge/__init__.py`. The bridge marker is the only one that reaches the container, and it is what `GET /version` reports.

- Never hand-edit a version field. `scripts/release.sh` owns the flow and hard-fails when the three disagree. The `version-bumper` skill decides whether a bump is due.
- Every release gets a `CHANGELOG.md` section.
- `admin-portal` redeploys from `main` via Netlify on its own. **The NAS does not.** A release touching the bridge needs `bun run deploy:nas` (or the `deploy-nas` skill) afterwards, then confirm with `GET /version`.

## Lint and enforcement

The repo does have linters: oxlint for TS/JS, stylelint for SCSS, ruff for Python, oxfmt for formatting, tsgo for type checking.

Several conventions below are enforced as lint errors, not just style preferences, in `apps/admin-portal/.oxlintrc.json` under a block marked "Conventions from CLAUDE.md": no default exports, `type` over `interface`, no `any`, no non-null assertions, `eqeqeq`, `prefer-const`, `prefer-array-flat-map`. Turning one of these off to make code pass is not the fix.

There is a second oxlint and oxfmt pair at the repo root, `.oxlintrc.json` and `.oxfmtrc.json`, covering everything outside `apps/`: the `.mjs` tooling under `scripts/` and `.claude/skills/**`, the docs, and the root config files. It ignores `apps` outright, since each app owns its own config, and it is a plain script rather than an Nx target because the repo root is not an Nx project. `bun run lint`, `format`, `format:check` and `verify` run it first and then fan out to the projects; `bun run lint:root`, `lint:root:fix`, `format:root` and `format:check:root` run only that pass. The root config disables four rules whose suggested fix contradicts the house style (`for…of` over `forEach`, mutating a `reduce` accumulator, mutating a mapped object, `toSorted` on an array that is already a fresh copy); each carries a comment saying so.

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

## Python

- Ruff is pinned to `target-version = "py312"` with `select = ["E4", "E7", "E9", "F", "I", "RUF"]`, so import order (`I`) is enforced. Run `bun run lint:py`, fix with `bun run lint:py:fix`
- Tests live in `apps/stripe-bridge/tests/` and `apps/fleet-monitor/tests/`, outside their runtime packages, and run under pytest via `bun run test:bridge` and `bun run test:monitor`
- `bun run setup:py` creates the local venv the bridge test suite expects; `bun run setup:py:monitor` does the same for fleet-monitor

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
