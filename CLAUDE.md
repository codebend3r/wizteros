# Claude context for wizteros

This file is loaded automatically when Claude Code runs inside this repo. It captures the working context that doesn't belong in the README.

## What this project is

A self-hosted stack that gates Plex access behind a recurring Stripe "server-cost contribution":

- **Wizarr** — invite-based onboarding for Plex users
- **Tautulli** — usage analytics
- **stripe-bridge** (`stripe-bridge/`) — small FastAPI service that converts Stripe webhooks (`checkout.session.completed`, `customer.subscription.deleted`) into Wizarr API calls

The contribution framing is deliberate (Plex TOS prohibits selling access, Stripe TOS prohibits selling rights you don't own). When suggesting copy, product descriptions, or UX text, lean toward infrastructure/hosting language. Never reference content, libraries, or titles in user-facing payment surfaces.

## Architecture

```
Stripe checkout → webhook → stripe-bridge → Wizarr API → Plex (invite or remove)
                                                   ↑
                                          Tautulli watches usage
```

The bridge is intentionally small. It does not persist its own state — it looks up Wizarr users by email at cancellation time. If that becomes fragile, the documented next step is a SQLite mapping of `stripe_customer_id` -> Wizarr user id.

## Operator context (as of 2026-05-24)

- 5 Synology NASes on `192.168.50.0/24`, each running its own Plex server. Naming theme: Game of Thrones dragons. 3 are connected to Wizarr (Meleys, Vermithor, Vhagar); 2 more to be added.
- Wizarr is reachable internally; no public hostname yet.
- Domain `cjrivas.io` is registered at name.com with default name.com nameservers. No live DNS records — Titan Email Premium subscription is attached but never configured (paid through 2027-01-30). Migration to Cloudflare is the planned path.
- GitHub: `codebend3r`. Repo is private.

## Planned tooling decisions

- Public reachability via **Cloudflare Tunnel** (chosen over ngrok and Tailscale Funnel for stable URLs at no recurring cost, plus real TLS certs via Cloudflare)
- Subdomains: `invite.cjrivas.io` -> `wizarr:5690`, `webhook.cjrivas.io` -> `stripe-bridge:8000`
- Stripe Payment Links (no custom checkout), webhook events: `checkout.session.completed` + `customer.subscription.deleted`

## Conventions

- Secrets live in `.env` (gitignored). `.env.example` is the source of truth for variable names.
- Compose volumes: `./wizarr-data/` and `./tautulli-config/` are runtime state, also gitignored.
- Don't introduce a database for the bridge until cancellation-by-email is actually broken in practice.
- Don't add backwards-compatibility shims — this stack has no users yet outside the operator.

## What's done vs what's next

Done:
- Repo scaffolded, README + Dockerfile + compose + bridge committed
- 3/5 Plex servers added in Wizarr
- DNS state on `cjrivas.io` verified clean (safe to migrate)

Next (in order):
1. Add `cjrivas.io` to Cloudflare, swap nameservers at name.com
2. Create Cloudflare Tunnel, add `cloudflared` service to `docker-compose.yml`, route `invite.cjrivas.io` and `webhook.cjrivas.io`
3. Generate Wizarr API key, fill `.env`
4. Create Stripe product + Payment Link + webhook endpoint pointing at `https://webhook.cjrivas.io/stripe/webhook`
5. Test end-to-end with Stripe CLI (`stripe trigger ...`) in test mode
6. Switch to Stripe live keys, announce to a small trusted group
7. Add remaining 2 Plex servers in Wizarr

## When helping with this repo

- If the operator asks "where were we", check this file's "Next" list and the GitHub repo state, not just chat history.
- The bridge is small on purpose. Resist suggesting frameworks, ORMs, queues, or test scaffolds unless the operator asks.
- For commit messages: short subject, optional bullet body. No Co-Authored-By or agent attribution trailers.
