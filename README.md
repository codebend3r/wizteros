# wizteros

A self-hosted stack that gates access to a private Plex setup behind a recurring Stripe "server-cost contribution". It glues together:

- **[Wizarr](https://github.com/wizarrrr/wizarr)** — invite-based user onboarding
- **[Tautulli](https://github.com/Tautulli/Tautulli)** — usage monitoring and analytics
- **stripe-bridge** (`stripe-bridge/`) — a small FastAPI service that turns Stripe webhooks into Wizarr API calls
- **web** (`web/`) — a Vite + React landing page that funnels visitors to the Stripe Payment Link

```
Stripe checkout → webhook → stripe-bridge → Wizarr → Plex
```

On `checkout.session.completed` the bridge creates a Wizarr invite and emails it to the customer. On `invoice.paid` (renewals) it extends the member's access for another cycle. On `customer.subscription.deleted` it disables the member's records.

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

Hooks run automatically: pre-commit lints and formats staged files, pre-push runs `npm run verify`.

Deployment details live in `docs/nas-deployment.md` and `docs/tailscale-funnel.md`; working conventions in `CLAUDE.md`.
