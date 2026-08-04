---
name: wizteros-webhook-e2e
description: Use when working on wizteros Stripe webhook handling, testing checkout or renewal or cancellation flows end to end, debugging why a webhook did not produce an invite, replaying a Stripe event, or running the bridge locally against Wizarr. Triggers include "test the checkout flow", "the webhook is not firing", "replay that event", "run the bridge locally", "stripe listen".
---

# wizteros Webhook End-to-End Testing

## Overview

The bridge turns three Stripe events into Wizarr calls. Testing it means either the scripted e2e loop (fast, deterministic, drives synthetic signed webhooks) or `stripe listen` (real events, slower). Start with the scripted loop.

## The scripted loop

```bash
bun run retest    # bridge:build + bridge:up + test:e2e
```

Individually:

```bash
bun run bridge:build                     # docker build -t stripe-bridge ./stripe-bridge
bun run bridge:up                        # runs on :8000 with --env-file .env
bun run test:e2e                         # node --env-file=.env scripts/e2e-retest.mjs
bun run bridge:logs                      # docker logs -f
bun run bridge:down
```

`scripts/e2e-retest.mjs` runs against the **live Wizarr instance** and a locally running bridge. It resets a test member's records to a clean baseline, then drives synthetic HMAC-signed webhooks and asserts every server record was time-boxed:

```
reset all N records to null expiry and enabled
checkout.session.completed  -> all N extended by ACCESS_DURATION
invoice.paid (renewal)      -> all N extended by ACCESS_DURATION
assert every record expires at roughly now + 2 * ACCESS_DURATION
```

It needs `WIZARR_BASE_URL`, `WIZARR_API_KEY`, and `STRIPE_WEBHOOK_SECRET` from `.env`, and takes an optional email as `argv[2]` (defaults to the maintainer's test address). Each run uses a unique `cus_e2e_<timestamp>` so the processed-events idempotency table never skips a run.

**It mutates a real Wizarr member.** Pass a test email you control. Never point it at a paying member.

## The two paths, and why both exist

Public URL is `/stripe/webhook`. Tailscale Funnel mounts the bridge with `--set-path=/stripe` and **strips that prefix**, so behind Funnel the request arrives as `/webhook`. Both paths are registered on the same handler, and `admin.router` is likewise mounted twice (bare and under `/stripe`). Local and `stripe listen` calls use the bare path; production Stripe uses `/stripe/webhook`.

A 404 on `/stripe/webhook` in production means Funnel lost its mount points, not that the bridge is down.

## Real events with `stripe listen`

```bash
stripe listen --forward-to localhost:8000/webhook
# use the whsec_ it prints as STRIPE_WEBHOOK_SECRET, then restart the bridge
stripe trigger checkout.session.completed
```

The signing secret must match the listener. Key, webhook secret, and payment links must all come from the same Stripe environment. Never mix live and test.

## The three handled events

| Event | Effect |
|---|---|
| `checkout.session.completed` | Resolve tier scope, create invite, email it, store pending row, then reconcile existing records |
| `invoice.paid` | Set `subscribed`, extend expiry by `ACCESS_DURATION`. First invoice (`billing_reason == "subscription_create"`) is skipped so signup does not double-extend |
| `customer.subscription.deleted` | Clear `subscribed`, disable every record |

## Debugging a webhook that did nothing

Work down this list.

1. **Signature.** A 400 `invalid signature` means the secret does not match the sender.
2. **Idempotency.** `skipping already-processed event <id>` in the logs means the `processed_events` table already has it. Replays of a real event id are dropped by design. Use a fresh event.
3. **Tier metadata.** No `metadata.tier` on the session logs `unknown tier ... defaulting to bronze`. The Payment Link is missing its metadata.
4. **Empty scope.** `no libraries resolved for <tier> tier checkout` raises deliberately so Stripe retries rather than sending an unscoped invite. Usually Wizarr is unreachable or every library is disabled.
5. **No email on the session.** `no email on session` returns early. The event is still marked processed.
6. **Wizarr slow or down.** `/api/users` routinely takes 15 seconds and is set to a 45 second timeout. A crash mid-handler leaves the event unmarked so Stripe's retry reprocesses it.

## Idempotency, and why the order matters

`handle_event` marks an event processed **only after** `_dispatch` returns without raising. That ordering is deliberate: a crash partway through must leave the event unmarked so Stripe's retry can complete the signup rather than losing it silently. Never move `mark_event_processed` earlier, and never wrap `_dispatch` in a bare `except` that swallows the failure.

## Unit tests

```bash
bun run test:bridge   # local venv, needs `bun run setup:py` once
bun run test:unit     # same suite inside the built Docker image
```

`tests/test_bridge.py` covers all three event types with `responses`-stubbed Wizarr calls. Add a case there before reaching for the live e2e loop.

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Running `test:e2e` against a real member's email | Their records get reset and re-timeboxed |
| Reusing a real Stripe event id | Dropped as already processed |
| Forwarding to `/stripe/webhook` locally | Works, but does not exercise the Funnel-stripped path |
| Restarting the bridge without updating `STRIPE_WEBHOOK_SECRET` after `stripe listen` | Every event 400s |
| Marking events processed before handling | Failed signups silently lost |
