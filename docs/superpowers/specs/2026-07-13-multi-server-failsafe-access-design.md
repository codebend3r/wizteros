# Multi-Server Fail-Safe Access — Design

## Problem

The stripe-bridge maps one Stripe subscription to Plex access via Wizarr, but two
defects break the real use case: **offboarding existing, never-expiring members
onto paid, time-boxed access** (and onboarding brand-new members).

1. **Revocation/renewal touches only one server.** Wizarr stores one record per
   `(user, server)`. A single member email therefore resolves to N records (the
   test account `codebenderinc@gmail.com` has 5: ids 147/57/106/155/204, one per
   server). The bridge resolves only the _first_ id and disables/extends only
   that one, so a cancellation leaves the member with access to the other N-1
   servers.

2. **Existing members are never time-boxed.** When an already-shared Plex account
   redeems an invite, Wizarr matches the existing membership instead of consuming
   the invite: the invite stays `status: pending` / `used_at: null` and the
   member's `expires` stays `null` (never expires). The invite's `duration`
   (35 days) only ever applies to brand-new members.

Both must work for a **brand-new member** and an **existing member who already has
access**.

## Verified Wizarr API behavior (against the live instance)

- `GET /api/users?email=<e>` returns one row per `(user, server)`; the unfiltered
  `GET /api/users` hangs and must not be used.
- `POST /api/users/{id}/extend {"days": n}`:
  - on a `null`-expiry record → **sets** expiry to `now + n days`.
  - on a record that already has an expiry → **adds** n days (compounds) — so it
    is NOT used; see below.
- `PUT /api/users/{id}/update-expiry {"expires": <ISO>}` sets an **absolute**
  expiry. An **empty body** `{}` sets "unlimited"; an explicit `null` is rejected
  (the swagger doc is wrong on this).
- `POST /api/users/{id}/disable` / `/enable` act on a single record.
- `POST /api/invitations` with `duration` correctly records the duration on the
  invite; redemption only applies it for brand-new memberships.

## Enforcement model: time-boxed / fail-safe

Access is guaranteed to lapse for a non-paying member because every paid member's
records carry an `expires` in the near future. Each paid event **sets** that expiry
to `update-time + ACCESS_DURATION` — absolute, not additive — so a record always
expires exactly `ACCESS_DURATION` days after the last payment. If any webhook is
missed, access self-expires within `ACCESS_DURATION` days — the service fails
closed, with a bounded exposure window.

| Stripe event                                      | Bridge action (across **all** of the member's records)                                                                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`                      | Create + email an invite (brand-new members redeem it for their initial expiry). Resolve existing records by email; if any exist (existing member), **set** each record's expiry to `now + ACCESS_DURATION` to time-box immediately. Store `customer_id → (email, invite_code)`. |
| `invoice.paid` (skip first `subscription_create`) | Resolve all records; **set** each to `now + ACCESS_DURATION`.                                                                                                                                                                                                                    |
| `customer.subscription.deleted`                   | Resolve all records; `disable` each.                                                                                                                                                                                                                                             |

Set (not extend) is deliberate: expiry is deterministic (`update date + duration`),
identical across all of a member's records, and the fail-safe window stays bounded
at `ACCESS_DURATION` rather than drifting forward with each renewal. Cancel disables
immediately regardless of remaining expiry.

**Locked decisions:**

- Cancel **disables** records (reversible, matches existing endpoint); it does not
  delete them.
- No separate checkout-time time-box for brand-new members: they have no records
  yet at checkout, so the set-expiry loop is naturally a no-op and invite
  redemption sets their initial expiry.

## Identity model — resolve to all records

`wizarr.py`:

- `find_user_ids_by_email(email) -> list[int]` — all records whose email matches
  (case-insensitive).
- `find_user_ids_by_invite(code) -> list[int]` — resolve the Plex username via the
  invite's `used_by`, then return all records for that username. Fallback for when
  the Stripe email differs from the Plex account email.
- `set_expiry(id, expires_iso)` (PUT update-expiry, absolute) and
  `disable_user(id)` remain per-record; callers loop. The bridge computes one
  `now + ACCESS_DURATION` timestamp per event and applies it to every record.

`stripe_wizarr_bridge.py`:

- `resolve_user_ids(client, db, customer_id, email) -> list[int]` — try email, then
  the invite-code fallback (via the stored `invite_code`). Returns a list (possibly
  empty). Replaces the single-id `resolve_user_id`.
- `handle_event` loops `extend`/`disable` over every resolved id and logs the count.

## Store

`upsert_pending` continues to persist `customer_id → (email, invite_code)`, which is
required because `invoice.paid`/`customer.subscription.deleted` may not carry the
email. The single `wizarr_user_id` cache column is no longer meaningful (identity is
N records, discovered live at event time); its read/write path is removed rather
than left as a misleading unused column. `mark_event_processed` idempotency is
unchanged.

## Edge cases

- **Brand-new member, invite not yet redeemed at checkout** → email lookup returns
  `[]`, the set-expiry loop is skipped, invite redemption sets the initial expiry.
- **Stripe email ≠ Plex email** → invite-code fallback resolves the username, then
  its records.
- **Duplicate/retried events** → guarded by the existing `mark_event_processed`
  store.
- **New server added to Wizarr after signup** → because ids are resolved live per
  event, a later renewal/cancel naturally covers the new record too.

## Testing / verification

- **Unit**: resolve-all-by-email, resolve-all-by-invite fallback, `set_expiry`
  loops over all ids with one absolute date, `disable` loops over all ids, checkout
  time-boxes an existing member (records exist) but is a no-op for a brand-new
  member (no records), new-user invite path unchanged, plus the StripeObject
  regression tests.
- **End-to-end** on `codebenderinc@gmail.com` (5 records): a repeatable Node command
  (`npm run retest`) resets all records to a clean baseline (enable + unlimited),
  drives signed `checkout.session.completed` + `invoice.paid` webhooks through the
  bridge, and asserts every record is set to `~now + ACCESS_DURATION` (identical
  absolute expiry across all five).

## Out of scope

- Bulk migration of the existing never-expiring membership base (a separate
  operator task; this bridge only time-boxes members as they pass through checkout).
- Any change to the free-tier manual-invite flow.
- Public reachability / go-live (Cloudflare Tunnel, live keys) — tracked separately.
