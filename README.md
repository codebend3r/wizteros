# wizteros

A self-hosted stack that gates access to a private Plex setup behind a recurring Stripe "server-cost contribution". It glues together:

- **[Wizarr](https://github.com/wizarrrr/wizarr)** — invite-based user onboarding
- **[Tautulli](https://github.com/Tautulli/Tautulli)** — usage monitoring and analytics
- **stripe-bridge** (`stripe-bridge/`) — a small FastAPI service that turns Stripe webhooks into Wizarr API calls, and serves the admin API
- **web** (`web/`) — a Vite + React site: a public landing page with the four pricing tiers, plus password-gated admin pages (`/manage`, `/invite`, `/reset-user`) backed by the bridge

```
Stripe checkout → webhook → stripe-bridge → Wizarr → Plex
```

On `checkout.session.completed` the bridge creates a Wizarr invite and emails it to the customer. On `invoice.paid` (renewals) it extends the member's access for another cycle. On `customer.subscription.deleted` it disables the member's records.

### Tiers

Each Stripe Payment Link carries a `tier` metadata key that scopes the invite: **Bronze** ($8, everything except 4K), **Silver** ($14, everything, no downloads), **Gold** ($20, everything + downloads), **Youth** ($10, a curated family allowlist + downloads) — all CAD/month. Libraries named `9X. …` are never shared, on any tier.

## Getting started

### Run the stack

You need Docker + Compose, a Plex server you administer, a Stripe account with a recurring Payment Link, SMTP credentials for the invite email, and public ingress for the webhook (this deployment uses Tailscale Funnel — see `docs/tailscale-funnel.md`).

```bash
git clone https://github.com/codebend3r/wizteros.git
cd wizteros
cp .env.example .env   # fill in real values; .env.example is the source of truth
docker compose up -d --build
```

On first boot, open Wizarr at `http://<host>:5690` and complete the setup wizard, then generate an API key in Wizarr settings and drop it into `.env` as `WIZARR_API_KEY`. Tautulli runs at `http://<host>:8181`; the bridge listens at `http://<host>:8000/stripe/webhook`.

### Develop

```bash
npm install        # root tooling — also installs the husky git hooks
npm run setup:py   # local venv for the bridge test suite
npm run verify     # lint + format check + typecheck + web and bridge unit tests
```

- Landing page dev server: `cd web && bun install && bun run dev`
- Bridge unit tests: `npm run test:bridge` (or `npm run test:unit` to run them in docker)
- End-to-end flow test against a running bridge: `npm run retest`
- Deploy the stack to the NAS: `npm run deploy:nas`

Hooks run automatically: pre-commit runs `bun run system-check` (oxlint, gale on SCSS, `oxfmt --check`, tsgo); pre-push runs `bun run verify`, which is system-check plus the web and bridge test suites. CI runs the same checks on every push.

The web toolchain is Rust/Go based: [oxlint](https://oxc.rs) for TS/JS, [gale](https://github.com/LyricalString/gale) for SCSS, [oxfmt](https://oxc.rs) for formatting (TS, JS, SCSS, JSON, YAML, Markdown), and [tsgo](https://www.npmjs.com/package/@typescript/native-preview) for type checking. Configs live in `web/`: `.oxlintrc.json`, `gale.json`, `.oxfmtrc.json`, plus `.editorconfig` in `web/` and `stripe-bridge/`. Fix what is fixable with `npm run lint:fix`, `npm run lint:css:fix`, and `npm run format`. `npm run typecheck:tsc` keeps tsc available as an escape hatch while tsgo is a preview release.

Deployment details live in `docs/nas-deployment.md` and `docs/tailscale-funnel.md`; the invite/renewal/cancel flow in `docs/invite-flow.md`; working conventions in `CLAUDE.md`.
