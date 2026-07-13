# wizteros

A self-hosted stack for running a private Plex server with managed access and recurring contribution-based gating.

It glues together three things:

- **[Wizarr](https://github.com/wizarrrr/wizarr)** — invite-based user onboarding for Plex
- **[Tautulli](https://github.com/Tautulli/Tautulli)** — usage monitoring and per-user analytics
- **stripe-bridge** — a small FastAPI service that listens for Stripe webhooks, generates Wizarr invites on successful checkout, and removes Plex access when a subscription is cancelled

## How it works

```
                                    +--------------+
  Customer pays  -->  Stripe  -->   | stripe-bridge|
                  webhook            +------+-------+
                                            |
                            create invite   |   delete user on cancel
                                            v
                                       +--------+
                                       | Wizarr |  --> Plex (via Wizarr's API)
                                       +--------+
                                            ^
                                     usage  |
                                            |
                                      +----------+
                                      | Tautulli |
                                      +----------+
```

On `checkout.session.completed` the bridge creates a Wizarr invite and emails it to the customer. On `customer.subscription.deleted` the bridge looks up the Plex user by email in Wizarr and removes them.

## Prerequisites

- Docker and Docker Compose
- A Plex Media Server you administer (and a Plex token for Wizarr setup)
- A Stripe account with a recurring product configured (see _Stripe setup_ below)
- An SMTP server for outbound mail (Fastmail, SendGrid, Mailgun, Gmail app password, etc.)
- A public hostname pointing at the host so Stripe can reach the webhook (Cloudflare Tunnel, Caddy, Traefik, or any reverse proxy works)

## Quick start

```bash
git clone https://github.com/codebend3r/wizteros.git
cd wizteros
cp .env.example .env
# fill in real values in .env (see "Environment variables" below)
docker compose up -d --build
```

Service URLs once it's up:

| Service       | Default URL                   |
| ------------- | ----------------------------- |
| Wizarr        | `http://<host>:5690`          |
| Tautulli      | `http://<host>:8181`          |
| stripe-bridge | `http://<host>:8000/stripe/webhook` |

On first boot, open Wizarr in a browser to complete the setup wizard (Plex token, library selection, server name). Then generate an API key in Wizarr settings and drop it into `.env` as `WIZARR_API_KEY`.

## Environment variables

All bridge configuration lives in `.env` (see `.env.example` for the template):

| Variable                | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `TZ`                    | Timezone for containers (e.g. `America/New_York`)              |
| `STRIPE_API_KEY`        | Stripe secret key (`sk_live_...` or `sk_test_...`)             |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the Stripe webhook endpoint (`whsec_...`)  |
| `WIZARR_BASE_URL`       | Internal Wizarr URL (default `http://wizarr:5690`)             |
| `WIZARR_API_KEY`        | API key generated in Wizarr settings                           |
| `WIZARR_SERVER_ID`      | ID of the Plex server registered in Wizarr (usually `1`)       |
| `INVITE_EXPIRES_DAYS`   | How long invite links remain valid before expiring             |
| `ACCESS_DURATION`       | Days of Plex access granted per billing cycle                  |
| `SMTP_HOST`/`PORT`/`USER`/`PASS` | Outbound mail server credentials                      |
| `FROM_ADDR`             | "From" address on the invite email                             |
| `PUBLIC_INVITE_BASE`    | Public URL where Wizarr is reachable (used in the invite link) |

## Stripe setup

1. Create a recurring product in Stripe (Dashboard -> Product Catalog -> Add product). Frame the description around infrastructure costs (server, electricity, bandwidth, storage), not media access.
2. Create a Payment Link for the price. Enable "Collect customer email".
3. Add a webhook endpoint pointing at `https://<your-public-host>/stripe/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` in `.env`.

### Local testing

Use the Stripe CLI to forward events to your dev machine before going live:

```bash
stripe listen --forward-to localhost:8000/stripe/webhook
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
```

## Operational notes

- **Cancellation timing.** `customer.subscription.deleted` fires as soon as the subscription ends. If you want to honor a grace period, listen for `customer.subscription.updated` instead and key off `cancel_at_period_end` + the period end timestamp.
- **Email-as-key is fragile.** If a customer pays with one email and registers Plex with a different one, the cancellation lookup will miss. For a more durable mapping, store `stripe_customer_id` <-> Wizarr user id in a tiny SQLite DB.
- **Failed payments.** Stripe handles retries automatically, but adding `invoice.payment_failed` lets you proactively warn the user.
- **Backups.** The `wizarr-data/` and `tautulli-config/` volumes hold all state. Snapshot them on a schedule.

## Legal and TOS considerations

This stack is intended for private use among a small group, where contributors are sharing the operating cost of a server you own.

- Plex's Terms of Service prohibit commercializing access to the platform.
- Stripe's Terms of Service prohibit transactions tied to content you don't have distribution rights to.

Framing payments as "contributions toward infrastructure" does not exempt you from either platform's policies; it just lowers the visibility of the arrangement. Run this with that understanding, keep the group small and invite-only, and don't advertise.

## License

No license is currently attached to this repository. Treat it as all rights reserved unless one is added.
