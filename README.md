# wizteros

A self-hosted stack that gates access to a private Plex setup behind a recurring Stripe "server-cost contribution". Stripe webhooks drive Wizarr invites, so paying members are onboarded and expired ones are disabled without manual work.

```
Stripe checkout → webhook → stripe-bridge → Wizarr → Plex
```

## Tech stack

- **[Wizarr](https://github.com/wizarrrr/wizarr)**: invite-based user onboarding
- **[Tautulli](https://github.com/Tautulli/Tautulli)**: usage monitoring and analytics
- **`apps/stripe-bridge/`**: FastAPI service (Python 3.12) that turns Stripe webhooks into Wizarr API calls and serves the admin API. Tested with pytest
- **`apps/admin-portal/`**: Vite + React 19 SPA (TypeScript, SCSS modules, zustand, TanStack Query) with the public landing page and the password-gated admin pages. Tested with bun test
- **Tooling**: [Nx](https://nx.dev) as the monorepo task runner over bun workspaces, [oxlint](https://oxc.rs) for TS/JS, [gale](https://github.com/LyricalString/gale) for SCSS, [oxfmt](https://oxc.rs) for formatting, [tsgo](https://www.npmjs.com/package/@typescript/native-preview) for type checking, husky for git hooks
- **Hosting**: Docker Compose on a NAS, Netlify for the SPA, Tailscale Funnel for webhook ingress

## Getting started

You need Docker + Compose, a Plex server you administer, a Stripe account with a recurring Payment Link, SMTP credentials for the invite email, and public ingress for the webhook.

```bash
git clone https://github.com/codebend3r/wizteros.git
cd wizteros
cp .env.example .env   # fill in real values; .env.example is the source of truth
docker compose up -d --build
```

On first boot, open Wizarr at `http://<host>:5690` and complete the setup wizard, then generate an API key in Wizarr settings and drop it into `.env` as `WIZARR_API_KEY`. Tautulli runs at `http://<host>:8181`; the bridge listens at `http://<host>:8000/stripe/webhook`.

### Develop

```bash
bun install        # whole workspace in one shot, also installs the husky git hooks
bun run setup:py   # local venv for the bridge test suite
bun run verify     # lint, format check, typecheck and tests across both apps
```

- Dev server: `bun run dev` (or `bunx nx run admin-portal:dev`)
- Fix what is fixable: `bun run lint:fix`, `bun run lint:css:fix`, `bun run format`
- Deploy the stack to the NAS: `bun run deploy:nas`

### Nx

The two apps are Nx projects, so tasks run through one graph with caching. `admin-portal` gets its targets from its `package.json` scripts; `stripe-bridge` declares its own in `apps/stripe-bridge/project.json`.

```bash
bunx nx show projects                  # admin-portal, stripe-bridge
bunx nx run admin-portal:test          # one target on one project
bunx nx run-many -t test               # that target everywhere it exists
bun run affected                       # only what the current branch changed
bunx nx graph                          # project graph in the browser
```

Hooks run automatically: pre-commit runs `bun run system-check` (lint, SCSS lint, format check, typecheck, tests for `admin-portal`); pre-push runs `bun run verify` across both apps. CI runs the same `bun run verify` on every push.

## Claude skills

The repo ships two Claude Code skills under `.claude/skills/`:

| Skill | What it does | How it's triggered |
| --- | --- | --- |
| `deploy-nas` | Ships `main` to the Synology NAS: syncs the repo, rebuilds the `stripe-bridge` container, verifies health, and rolls back a bad build. The web app is untouched (it deploys via Netlify). | "deploy to the NAS", "rebuild the bridge", "ship main", "is the NAS running the latest code", or any follow-up to a merged PR that touched `stripe-bridge/` |
| `version-bumper` | Checks whether `origin/main` is ahead of the last `WZ: Bump version to X.Y.Z` commit, recommends a bump level (patch, minor, major), and on approval runs `scripts/release.sh` to bump, commit, and tag. | "should we cut a release", "bump the version", "what version should this be", "is main ahead of the last release", or after PRs merge to main and a release feels due |

## Docs

Tiers and the invite/renewal/cancel flow in `docs/invite-flow.md`; deployment in `docs/nas-deployment.md` and `docs/tailscale-funnel.md`; working conventions in `CLAUDE.md`.
