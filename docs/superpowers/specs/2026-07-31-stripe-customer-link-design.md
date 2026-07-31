# Stripe customer link on the User page — design

Date: 2026-07-31
Status: approved (placement and visibility confirmed in session)

## Goal

From a member's `/user` page, jump straight to their Stripe customer record in
the dashboard (e.g. `https://dashboard.stripe.com/acct_…/customers/cus_…`).
Driven entirely by data — any member whose checkout produced a real Stripe
customer id gets the link (Jimmy Vo, canexan@gmail.com, and every future
subscriber), with no per-person work.

## Decisions

- **Placement:** User page only, a `Stripe` row in the details list after
  `Tag`. The Manage table is untouched.
- **Visibility:** the link shows whenever a real `cus_` id exists, not only
  while `subscribed` is true — lapsed/canceled members are exactly the ones
  whose billing needs investigating.
- **URL construction:** the bridge exposes the raw `customer_id`; the web app
  builds the URL from a `VITE_STRIPE_DASHBOARD_URL` env var. This keeps the
  bridge a data API, follows the `VITE_BILLING_PORTAL_URL` convention, and
  makes an account change a Netlify env edit instead of a NAS rebuild.

Rejected: bridge-built full URL (bakes presentation into the API; account id
would need a manual NAS container rebuild to change), hardcoding the base URL
in `site.config.ts` (breaks the deployment-URLs-live-in-env convention).

## Bridge (`stripe-bridge/`)

- `store.all_customer_rows` adds `customer_id` per row: the
  `stripe_customer_id` when it starts with `cus_`, else `None` (admin-issued
  placeholder rows are keyed `admin:<email>` and must not leak).
- `admin._dedupe_members` and `admin._member_from_customer` pass
  `customer_id` through, so both `/admin/members` and `/admin/member` carry
  it. No new endpoints, no schema change.

## Web (`web/`)

- `Member` gains `customer_id: string | null`. `MemberPayload` keeps it
  optional with a field check, and `toMember` defaults it to `null` — a
  bridge deployed before this field must not fail validation (same pattern as
  `libraries`/`tag`).
- `site.config.ts`: `RawEnv` gains `VITE_STRIPE_DASHBOARD_URL`, `SiteConfig`
  gains `stripeDashboardUrl: string | null`.
- `User.tsx` details list: a `Stripe` row after `Tag`. With both
  `member.customer_id` and `stripeDashboardUrl` present it renders an
  external link to `${base}/customers/${id}` (new tab, `rel="noreferrer"`)
  whose text is the `cus_…` id, so it can be eyeball-matched against Stripe.
  Otherwise the row shows `—`.
- `src/test/env.ts`: `VITE_STRIPE_DASHBOARD_URL` joins `DORMANT_VARS`.

## Config

`VITE_STRIPE_DASHBOARD_URL=https://dashboard.stripe.com/acct_1TslbxC630uITbFX`
in Netlify and local `web/.env`.

## Testing

- Bridge: placeholder rows resolve to `customer_id=None`; real ids surface in
  both `/admin/members` and `/admin/member` payload shapes.
- Web: payload parsing tolerates a missing `customer_id`; the User page shows
  the link when id + env are present, `—` when either is absent.

## Rollout

The NAS bridge container must be rebuilt before the field appears in live
payloads; until then the web app degrades to `—`.
