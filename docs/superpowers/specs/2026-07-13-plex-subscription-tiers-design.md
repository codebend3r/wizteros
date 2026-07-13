# Plex server-cost subscriptions — two-tier design

**Date:** 2026-07-13
**Status:** Approved (design), pending implementation plan
**Repo:** `codebend3r/wizteros`

## Goal

Gate Plex access behind a two-tier model to help cover server costs:

- **Free tier** — family and VIP users pay nothing, access never expires.
- **Paid tier** — everyone else contributes **$8/month** via Stripe; access is
  granted on payment, extended on each renewal, and disabled on cancellation.

Wizarr manages invites and Plex user lifecycle. Stripe manages billing. The
existing `stripe-bridge` FastAPI service connects the two.

## Non-goals

- No custom checkout UI — Stripe Payment Links only.
- No unified pipeline for free users — they never touch Stripe (see below).
- No refactor of Wizarr or Tautulli — they are used as-is via their APIs.

## Two-tier model

The two tiers live in **completely separate lanes**. This is the core
simplification: free access requires zero code and zero Stripe configuration.

| Tier | Who | Mechanism | Expiry |
| ---- | --- | --------- | ------ |
| **Free** (family/VIP) | Operator's choice | Operator generates a Wizarr invite **directly in Wizarr's admin UI**, duration = *unlimited*. Never touches Stripe or the bridge. | Never |
| **Paid** ($8/mo) | Everyone else | Stripe Payment Link → webhook → `stripe-bridge` → Wizarr invite. | Auto-extended each billing cycle; disabled on cancel. |

## Paid pipeline

```
Stripe Payment Link ($8/mo recurring)
        │  webhook events
        ▼
   stripe-bridge (FastAPI, :8000)
        │
        ├─ checkout.session.completed   → create Wizarr invite → email link   [built]
        ├─ invoice.paid                 → extend Wizarr user +ACCESS_DURATION  [NEW]
        └─ customer.subscription.deleted → disable Wizarr user                 [CHANGE]
                                                   │
                                                   ▼
                                              Wizarr → Plex
```

Stripe webhook endpoint subscribes to exactly three events:
`checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`.

## Verified Wizarr API surface

Confirmed against Wizarr source (`app/blueprints/api/api_routes.py`,
`.../models.py`) — all endpoints exist and are authenticated by `X-API-Key`:

- `POST /api/invitations` — create invite (`server_ids`, `expires_in_days`, `duration`, `unlimited`).
- `GET  /api/users` — list users (includes `id`, `email`, `expires`).
- `POST /api/users/{id}/extend` — body `{"days": <int>}`, extends `expires` (adds to existing expiry if set, else from now).
- `POST /api/users/{id}/disable` — revoke access, preserve the record.
- `POST /api/users/{id}/enable` — re-activate a disabled user.
- `DELETE /api/users/{id}` — hard removal (no longer used on cancel).

## Changes to `stripe-bridge/stripe_wizarr_bridge.py`

The scaffold already handles the create-invite and cancel paths. Three changes:

### 1. Add `invoice.paid` handler (renewals)

On each successful monthly charge, extend the user's Wizarr membership by
`ACCESS_DURATION` days via `POST /api/users/{id}/extend`.

- **Skip the first invoice.** The initial invoice fires alongside
  `checkout.session.completed`; extending there would double-grant. Detect via
  `invoice.billing_reason == "subscription_cycle"` (renewals) vs
  `"subscription_create"` (first charge — skip).
- Resolve the Wizarr user via the identity mapping (below).

### 2. Cancel = disable, not delete

Change the `customer.subscription.deleted` handler to call
`POST /api/users/{id}/disable` instead of `DELETE /api/users/{id}`. Preserves
watch history and allows instant re-enable for a returning subscriber. Wizarr's
own expiry sweep will hard-remove stale users on its normal schedule.

### 3. Durable identity mapping (SQLite)

Replace fragile email-based lookup with a small persistent mapping. Email lookup
breaks when a customer pays with one email and signs into Plex with another —
and renewals now need a reliable lookup on *every* cycle, not just once.

- Single SQLite table: `stripe_customer_id (PK) → wizarr_user_id`, plus `email`
  and `created_at` for debugging.
- **Populated at invite time.** On `checkout.session.completed`, after creating
  the invite, record `stripe_customer_id → wizarr_user_id`. Note: the Wizarr
  *user* does not exist until the invitee completes Plex signup, so store what is
  known (customer id + email + invite code) and resolve/backfill the
  `wizarr_user_id` on the first `invoice.paid`/lookup by matching the invite or
  email. Keep the email fallback as a secondary lookup path.
- File lives on a mounted volume so it survives container restarts
  (`./stripe-bridge-data/bridge.db` or similar; add to compose + `.gitignore`).
- ~1 table, ~15–25 lines. This is the one deliberate divergence from the repo's
  "no DB until email lookup actually breaks" note — justified because auto-extend
  makes the lookup a per-cycle hot path.

## Configuration

Existing `.env` variables are sufficient; `ACCESS_DURATION` (default 35 = one
month + ~5-day grace) is reused as the extend increment. Add:

- Volume path for the SQLite mapping DB.

No new secrets required beyond what `.env.example` already lists.

## Deployment — two phases

The bridge runs **standalone** and talks to the operator's **existing, already
configured Wizarr** (3 Plex servers) over the LAN. The local
`/Users/snowball/Docker/docker-compose.yml` is out of scope and untouched.

### Phase 1 — build + test locally (no DNS / no Cloudflare)

1. Make the three bridge code changes (invoice.paid extend, cancel=disable,
   SQLite mapping).
2. Generate a Wizarr API key; fill a local `.env` with
   `WIZARR_BASE_URL=http://192.168.50.141:5690` and the key.
3. Run the bridge locally (`docker run` / `uvicorn`) on `:8000`.
4. Forward Stripe test events to it with the Stripe CLI — **no public URL
   needed**: `stripe listen --forward-to localhost:8000/stripe/webhook`, then
   `stripe trigger checkout.session.completed` / `invoice.paid` /
   `customer.subscription.deleted`. `stripe listen` prints the `whsec_...`
   signing secret to use for `STRIPE_WEBHOOK_SECRET` during testing.
5. Assert each event routes to the correct Wizarr API call.

### Phase 2 — go live (deferred until Phase 1 passes)

1. Migrate `cjrivas.io` DNS to Cloudflare; create a Cloudflare Tunnel exposing
   `webhook.cjrivas.io → bridge:8000` (and optionally `invite.cjrivas.io`).
2. Add a **live-mode** Stripe webhook endpoint at
   `https://webhook.cjrivas.io/stripe/webhook` for the three events; copy its
   signing secret into the live `.env`.
3. Recreate the $8/mo product + Payment Link in **live mode** (test-mode
   artifacts do not carry over).
4. Switch the bridge to Stripe **live** keys; invite a small trusted group.

### Stripe artifacts (test mode, created 2026-07-13)

- Product `prod_UsX4Mm0lFpwhCY`, Price `price_1Tsm0TC1UCLdptRFbZgAGUsL`
  ("Media Server Hosting — Monthly", CA$8.00/month recurring).
- Payment Link `https://buy.stripe.com/test_bJe6oG2Yte2m7l1f721Nu00`.
- Live-mode equivalents to be created in Phase 2.

## Testing

- **Bridge unit/behavior:** signature verification rejects bad payloads; each of
  the three event types routes to the correct Wizarr call; first-invoice skip
  logic; identity mapping insert/lookup/backfill.
- **Integration (Stripe CLI, test mode):** trigger each event, assert the
  corresponding Wizarr API call fires with expected args.
- **Manual free-tier check:** operator-created unlimited Wizarr invite grants
  non-expiring access and never appears in the bridge's logs.

## Error handling

- Invalid Stripe signature → HTTP 400, no side effects.
- Missing email on an event → log warning, return 200 (don't force Stripe retries
  on unrecoverable data).
- Wizarr API failure → log, return non-2xx so Stripe retries the webhook.
- Unknown/unhandled event type → log and return 200.

## Legal / TOS constraints (binding on all copy)

- Plex TOS prohibits **selling access**; Stripe TOS prohibits charging for
  **content you don't own the rights to**. "Infrastructure contribution" framing
  lowers visibility but does not exempt either.
- All user-facing payment surfaces (product name, description, invite email) use
  infrastructure/hosting language only — **never** reference libraries, titles,
  or media content.
- Keep the group small, invite-only, unadvertised.

## Open items (deferred, not blocking)

- Optional `invoice.payment_failed` handler to proactively warn users before
  cancellation. Deferred — Stripe already handles retries.
- Grace-period tuning via `customer.subscription.updated` +
  `cancel_at_period_end` if instant cutoff proves too harsh.
