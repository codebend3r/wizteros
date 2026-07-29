# wizteros

A self-hosted stack that gates access to a private Plex setup behind a recurring Stripe "server-cost contribution". Stripe webhooks drive Wizarr invites, so paying members are onboarded and expired ones are disabled without manual work.

```
Stripe checkout → webhook → stripe-bridge → Wizarr → Plex
```

## Tech stack

- **[Wizarr](https://github.com/wizarrrr/wizarr)**: invite-based user onboarding
- **[Tautulli](https://github.com/Tautulli/Tautulli)**: usage monitoring and analytics
- **`stripe-bridge/`**: FastAPI service (Python 3.12) that turns Stripe webhooks into Wizarr API calls and serves the admin API. Tested with pytest
- **`web/`**: Vite + React 19 SPA (TypeScript, SCSS modules, zustand, TanStack Query) with the public landing page and the password-gated admin pages. Tested with bun test
- **Tooling**: bun as package manager, [oxlint](https://oxc.rs) for TS/JS, [gale](https://github.com/LyricalString/gale) for SCSS, [oxfmt](https://oxc.rs) for formatting, [tsgo](https://www.npmjs.com/package/@typescript/native-preview) for type checking, husky for git hooks
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
bun install        # root tooling, also installs the husky git hooks
bun run setup:py   # local venv for the bridge test suite
bun run verify     # lint, format check, typecheck, web and bridge tests
```

- Landing page dev server: `cd web && bun install && bun run dev`
- Fix what is fixable: `bun run lint:fix`, `bun run lint:css:fix`, `bun run format`
- Deploy the stack to the NAS: `bun run deploy:nas`

Hooks run automatically: pre-commit runs `bun run system-check` (lint, SCSS lint, format check, typecheck); pre-push runs `bun run verify`. CI runs the same checks on every push.

## Docs

Tiers and the invite/renewal/cancel flow in `docs/invite-flow.md`; deployment in `docs/nas-deployment.md` and `docs/tailscale-funnel.md`; working conventions in `CLAUDE.md`.
