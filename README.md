# wizteros

A self-hosted stack that gates access to a private Plex setup behind a recurring Stripe "server-cost contribution". Stripe webhooks drive Wizarr invites, so paying members are onboarded and expired ones are disabled without manual work.

```
Stripe checkout → webhook → stripe-bridge → Wizarr → Plex
```

## Contents

- [Structure](#structure)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Development](#development)
- [Nx](#nx)
- [Releases](#releases)
- [Claude skills](#claude-skills)
- [Claude agents](#claude-agents)
- [Docs](#docs)

## Structure

An Nx monorepo over bun workspaces (`workspaces: ["apps/*"]`), with two apps and no shared libs.

```
wizteros/
├── apps/
│   ├── admin-portal/           Vite + React SPA, deploys to Netlify
│   │   ├── public/
│   │   └── src/                components/ pages/ lib/ stores/ styles/ test/
│   ├── fleet-monitor/          NestJS API and collector for the NAS fleet, runs in Docker on the NAS
│   │   └── src/                runtime code, with each module's *.test.ts beside it
│   └── stripe-bridge/          NestJS service, runs in Docker on the NAS
│       ├── src/                runtime code, with each module's *.test.ts beside it
│       └── scripts/            e2e and library snapshot entrypoints
├── libs/
│   └── server-common/          the admin guard, SQLite and env helpers both servers share
├── docs/                       specs, plans, and PRDs for both apps
├── scripts/                    release, backfill, and deploy entrypoints
├── .claude/agents/             repo-scoped Claude Code subagents
├── .claude/skills/             repo-scoped Claude Code skills
├── docker-compose.yml          builds and runs the bridge and the fleet monitor
├── netlify.toml                builds admin-portal only
├── nx.json                     target defaults, cacheable targets, named inputs
└── package.json                bun workspaces plus aliases that delegate to Nx
```

| Path                      | What lives there                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin-portal/src/`  | Public landing page and the password-gated admin pages. The `@/*` import alias maps here                                                              |
| `apps/stripe-bridge/src/` | Bridge runtime: `webhook/` (the Stripe handlers), `admin/` (the admin API), `loops.ts`, `store.ts`, `tiers.ts`, and the service clients in `clients/` |
| `apps/*/` roots           | Per-app config: `vite.config.ts`, `tsconfig.json`, `bunfig.toml`, `nest-cli.json`, `Dockerfile`, lint and format configs                              |

Two things that are easy to get wrong:

- Bridge modules import through the `@/` alias with a `.js` extension (`@/store/openStore.js`), never relative; `nest build` rewrites the alias in `dist`.
- Web imports use the `@/` alias, never parent-relative `../`. Same-directory `./` imports are fine.

## Tech stack

**Services**

| Component                                        | Role                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| [Wizarr](https://github.com/wizarrrr/wizarr)     | Invite-based user onboarding                                                                                |
| [Tautulli](https://github.com/Tautulli/Tautulli) | Usage monitoring and analytics                                                                              |
| `apps/stripe-bridge/`                            | NestJS on Node 24: turns Stripe webhooks into Wizarr API calls and serves the admin API. Tested with Vitest |
| `apps/fleet-monitor/`                            | NestJS on Node 24: probes the NAS fleet over ssh and serves the portal's Fleet and Plays pages. Vitest      |
| `apps/admin-portal/`                             | Vite + React 19 SPA (TypeScript, SCSS modules, zustand, TanStack Query). Tested with bun test               |

**Tooling**

[Nx](https://nx.dev) as the task runner over bun workspaces, [oxlint](https://oxc.rs) for TS/JS, [stylelint](https://stylelint.io) for SCSS, [oxfmt](https://oxc.rs) for formatting, [tsgo](https://www.npmjs.com/package/@typescript/native-preview) for type checking, [lefthook](https://lefthook.dev) for git hooks, [lint-staged](https://github.com/lint-staged/lint-staged) for the staged-file pass.

**Hosting**

Docker Compose on a NAS for the bridge, Netlify for the SPA, Tailscale Funnel for webhook ingress.

## Getting started

You need Docker + Compose, a Plex server you administer, a Stripe account with a recurring Payment Link, SMTP credentials for the invite email, and public ingress for the webhook.

```bash
git clone https://github.com/codebend3r/wizteros.git
cd wizteros
cp .env.example .env   # fill in real values; .env.example is the source of truth
docker compose up -d --build
```

> **Wizarr and Tautulli are not in this compose file.** It builds and runs `stripe-bridge` on port `8000`, plus the fleet monitor's API and collector. Wizarr and Tautulli run as a separate stack (on the NAS, the `westeroz` compose project), and the bridge reaches Wizarr over its host-published port rather than container DNS.

So bring up Wizarr first, then point the bridge at it:

1. Open Wizarr (default `http://<host>:5690`) and complete the setup wizard.
2. Generate an API key in Wizarr settings.
3. Put it in `.env` as `WIZARR_API_KEY`, with `WIZARR_BASE_URL` set to that Wizarr.
4. Start the bridge with the command above.

Once it is up: the webhook endpoint is `http://<host>:8000/stripe/webhook`, and `http://<host>:8000/version` reports the release the container is running. Tautulli, if you run it, defaults to `http://<host>:8181`.

## Development

```bash
bun install        # whole workspace in one shot, also installs the lefthook git hooks
bun run verify     # lint, format check, typecheck, tests and build across every project
```

| Task                         | Command                                           |
| ---------------------------- | ------------------------------------------------- |
| Dev server                   | `bun run dev`                                     |
| Fix what is fixable          | `bun run lint:fix`, `bun run format`              |
| Test one app                 | `bun run test:web`, `bun run test:bridge`         |
| Bridge container             | `bun run bridge:up`, `bridge:down`, `bridge:logs` |
| Only what changed            | `bun run affected`                                |
| Re-run the pre-commit gate   | `bun run system-check:no-cache`                   |
| Deploy the bridge to the NAS | `bun run deploy:nas`                              |

Hooks run automatically, from `lefthook.yml` at the root. Pre-commit first runs
`bun run lint:staged`, which fixes only the files in the commit (`oxlint --fix`
and `oxfmt` on TS/TSX, `stylelint --fix` and `oxfmt` on SCSS) and re-stages the
result, then `bun run system-check` (lint, SCSS lint, format check, typecheck,
and tests for `admin-portal`). Pre-push runs `bun run verify` across every project.
CI runs the same `bun run verify` on every push.

`system-check` reads the Nx cache, so a rerun with nothing changed reports a hit
without executing anything. `bun run system-check:no-cache` runs the identical
five targets with `--skip-nx-cache`, forcing every one to execute and skipping
both the local and the remote cache. Reach for it when a cached pass looks
wrong, when a tool was upgraded outside the hashed inputs, or when timing the
real cost of the gate.

lint-staged is configured per app, in `apps/*/.lintstagedrc.json`, plus
`.lintstagedrc.json` at the root for everything outside `apps/`; the closest
config to a staged file wins and its tasks run from that config's directory.

Everything outside `apps/` (the `scripts/` and `.claude/skills/**` `.mjs`
tooling, the docs, and the root config files) is linted and formatted from the
root `.oxlintrc.json` and `.oxfmtrc.json`. That pair is not an Nx target, since
the repo root is not an Nx project, so `bun run lint`, `format`, `format:check`
and `verify` each run it directly before fanning out to the projects. To run
just that pass: `bun run lint:root`, `bun run lint:root:fix`,
`bun run format:root`, `bun run format:check:root`.

## Nx

Every app and the lib are Nx projects, so tasks run through one graph with caching. Run tasks through Nx rather than by cd-ing into an app.

```bash
bunx nx show projects                  # admin-portal, stripe-bridge, fleet-monitor, @wizteros/server-common
bunx nx run admin-portal:test          # one target on one project
bunx nx run-many -t test               # that target everywhere it exists
bunx nx graph                          # project graph in the browser
```

Where targets come from:

| Project         | Source                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin-portal`  | Inferred from its `package.json` scripts, whitelisted by `nx.includedScripts`                                                                                                              |
| `stripe-bridge` | Both: `package.json` scripts (`build`, `typecheck`, `lint:ts`, `test`, e2e) via `nx.includedScripts`, plus `project.json` for the Docker targets (`docker-build`, `serve`, `stop`, `logs`) |
| `fleet-monitor` | Both: the same `package.json` scripts (without e2e), plus `project.json` for `docker-build`                                                                                                |

Use `bunx nx show project <name>` to see a project's real target list rather than guessing from one file.

Caching is declared in `nx.json` under `targetDefaults`. Anything that touches Docker or the network must stay `cache: false`.

## Releases

Every `package.json` in the workspace (the root, each app, and the lib) carries the release version, and they move in lockstep along with `bun.lock`'s workspace entries. `node scripts/version-markers.mjs` lists them and `--check` confirms they agree. The bridge one is the only marker that reaches a container, and it is what `GET /version` reports.

```bash
bun run release:patch      # bump every marker, commit, and tag
bun run release:backfill   # publish GitHub Releases from CHANGELOG.md
```

Never hand-edit a version field: `scripts/release.sh` owns the flow and hard-fails when any marker disagrees. Each release gets a `CHANGELOG.md` section. The SPA redeploys from `main` via Netlify on its own, the NAS does not, so a release touching the bridge needs `bun run deploy:nas` afterwards.

## Claude skills

Skills under `.claude/skills/` are scoped to this repo. Each one's `SKILL.md` carries the trigger phrases that invoke it; you can also call one by name.

**Repo workflow**

| Skill              | What it does                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commiter`         | Enforces the `CLAUDE.md` commit and PR conventions, keeping unrelated changes in separate commits                                                     |
| `pr-creator`       | Creates, drafts, formats, and validates pull requests against those same conventions                                                                  |
| `version-bumper`   | Decides whether `main` is due for a release, recommends a level, and runs the release flow on approval                                                |
| `deploy-nas`       | Ships `main` to the Synology NAS: syncs, rebuilds `stripe-bridge`, verifies health, rolls back a bad build                                            |
| `e2e-runner`       | Runs the live e2e suites safely: what each asserts, what it mutates on the live Wizarr, and how to clean up a dead run                                |
| `nas-state-backup` | Snapshots live NAS state (bridge DB, `wizarr-data`) before anything can destroy it                                                                    |
| `wizarr-upgrade`   | Upgrades or rolls back the live Wizarr container, and judges whether a new release is safe to take                                                    |
| `arr-stack-update` | Moves the media-stack images (sonarr, radarr, sabnzbd, …) on Meleys and Vermithor to latest, recreating only what changed and rolling back what fails |
| `copy-compliance`  | Audits user-facing copy against the server-cost contribution framing                                                                                  |
| `sales-agent`      | Finds win-back opportunities among declined and lapsed members, ranks them, and drafts a compliance-checked email to send by hand                     |
| `invite-audit`     | Audits the invitation set: the four per-tier baseline links, their expiry and scope, and whether the 03:00 rotation is still running                  |
| `monitor-ci`       | Watches Nx Cloud CI, evaluates failures, and coordinates supported self-healing fixes                                                                 |

**Nx**

| Skill                     | What it does                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `nx-workspace`            | Explores projects, targets, and configuration without changing anything                 |
| `nx-run-tasks`            | Runs targets for one, many, or only affected projects                                   |
| `nx-generate`             | Finds and runs the right generator, then checks the output against repo conventions     |
| `nx-plugins`              | Finds and installs Nx plugins for frameworks and other technologies                     |
| `nx-import`               | Imports another repository into the workspace while preserving history                  |
| `link-workspace-packages` | Links sibling packages with the package manager instead of path aliases or manual edits |

## Claude agents

Subagents under `.claude/agents/` are scoped to this repo the same way.

| Agent               | What it does                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `wizteros-reviewer` | Reviews a diff, branch, or PR against the `CLAUDE.md` conventions the toolchain does not enforce; read-only, reads the rulebook at review time |
| `sales-agent`       | Ranks membership growth opportunities and drafts win-back copy; read-only, never sends and never mutates a member                              |

## Docs

| Topic                                             | Where                                                |
| ------------------------------------------------- | ---------------------------------------------------- |
| Tiers and the invite/renewal/cancel flow          | `docs/invite-flow.md`                                |
| Failed payments, dunning, and duplicate customers | `docs/billing-failures.md`                           |
| NAS deployment                                    | `docs/nas-deployment.md`                             |
| The *arr media stacks on the NAS                  | `docs/arr-stack.md`                                  |
| Webhook ingress                                   | `docs/tailscale-funnel.md`                           |
| Specs and plans                                   | `docs/superpowers/specs/`, `docs/superpowers/plans/` |
| Product requirements                              | `docs/prd/`                                          |
| Release history                                   | `CHANGELOG.md`                                       |
| Working conventions                               | `CLAUDE.md`                                          |
