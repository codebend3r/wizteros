# Subscription tiers design

Date: 2026-07-16
Status: approved

## Goal

Offer four subscription tiers, each mapping a Stripe purchase to a Wizarr invite
scoped to a specific set of Plex libraries and a downloads permission. Private
Caraxes libraries (names prefixed `9X.`, e.g. `99. Tutorials`) are never shared
under any tier, under any circumstance.

## Tiers

| Tier   | Price (CAD/mo) | Libraries                                                                   | Downloads |
| ------ | -------------- | --------------------------------------------------------------------------- | --------- |
| Bronze | $8             | All − private − any name containing "4K"                                    | Off       |
| Silver | $14            | All − private (4K included)                                                 | Off       |
| Gold   | $20            | All − private (4K included)                                                 | On        |
| Kids   | $20            | Kid Shows (Vermithor), Family Movies (Meleys), 4K Family Movies (Vermithor) | On        |

- "Private" = any Caraxes library whose name matches `^9\d\.` (currently 96. Assignments, 97. Home Videos, 98. Documents, 99. Tutorials).
- "4K" match is case-insensitive on the library name.
- Library sets are computed live at invite time from `GET /api/libraries`
  (name rules, not stored IDs), so they survive Wizarr ID churn and
  automatically pick up new libraries.
- Invite `server_ids` are derived from the servers of the selected libraries;
  a Kids invite grants only Vermithor + Meleys.

## Tier detection (Stripe → bridge)

- One product per tier. The existing Test-mode product
  "Media Server Hosting (Bronze)" ($8 CAD/mo) is kept; Silver ($14), Gold
  ($20), and Kids ($20) are created alongside it, same naming pattern.
- One payment link per product. Each link carries `metadata.tier` set to
  `bronze` | `silver` | `gold` | `kids`. The existing Bronze link is updated
  in place (payment links accept metadata edits).
- Stripe copies payment-link metadata onto the checkout session, so the
  `checkout.session.completed` payload the bridge already receives contains
  `metadata.tier` directly — no extra API calls, no price-ID bookkeeping,
  and Test/Live modes need no divergent config.
- Missing or unknown tier → treat as Bronze (most restrictive) and log an
  error.
- Product descriptions and all user-facing payment copy use infrastructure
  language (streaming quality, offline sync) — never library or content
  names.

## Bridge changes (`stripe-bridge/`)

- New `tiers.py` module: tier definitions (name rules + downloads flag) and a
  resolver that takes the live library list and a tier name and returns
  `{library_ids, server_ids, allow_downloads}`.
- **Hard privacy guard**: a final filter immediately before the invite API
  call strips any library matching the private rule, independent of the tier
  rules, so a future rule change or bug can never share them.
- `WizarrClient` gains `list_libraries()`; `create_invite` gains
  `library_ids` and `allow_downloads` parameters.
- If a Kids allowlist entry doesn't match any live library (e.g. renamed),
  log loudly and proceed with what matched — never block a paid signup.
- `invoice.paid` (renewals) and `customer.subscription.deleted`
  (cancellation) flows are unchanged; tier only matters at invite creation.

## Web changes (`web/`)

- `site.config.ts`: replace the single `priceLabel`/`paymentLinkUrl` with a
  `tiers` array (name, CAD price label, feature bullets, payment link URL).
- Env: `VITE_PAYMENT_LINK_URL` is replaced by `VITE_PAYMENT_LINK_BRONZE_URL`,
  `VITE_PAYMENT_LINK_SILVER_URL`, `VITE_PAYMENT_LINK_GOLD_URL`,
  `VITE_PAYMENT_LINK_KIDS_URL`. No back-compat shim (repo convention).
- New `Pricing` component: four cards, SCSS module, grid + gap layout, token
  values from `styles/globals.scss`. Hero CTA scrolls to the pricing section.
- Card copy in capability framing: Bronze "standard streaming", Silver "adds
  4K streaming", Gold "4K + offline downloads", Kids "family plan, curated
  for kids, downloads included".
- Update `site.config.test.ts` and `App.test.tsx`; add tests for the tier
  config and pricing cards.

## Testing

- Pytest (bridge): tier resolution from metadata (all four tiers, missing,
  unknown); rule computation against a fixture library list asserting the
  private libraries appear in **no** tier's output, 4K excluded from Bronze
  only, Kids' exact set, downloads flags, and server-ID derivation.
- Vitest (web): tier config resolution and pricing card rendering.
- Manual E2E in Test mode: one test checkout per tier, then verify each
  resulting invite via the Wizarr API — correct libraries, correct downloads
  flag, Kids invite spanning only Vermithor + Meleys.

## Rollout

1. Implement + tests green locally.
2. Stripe Test mode: create Silver/Gold/Kids products + links, tag all four
   links with `metadata.tier`.
3. Commit, `npm run deploy:nas`, force-recreate the bridge container.
4. Netlify: set the four payment-link env vars, redeploy the site.
5. Run the per-tier E2E checks.
6. Live-mode products/links are created during the already-planned go-live
   step (same shapes, same metadata, no code changes).

## Out of scope

- Tier upgrades/downgrades: handled manually in Plex/Wizarr for now (no
  users yet; Wizarr's API cannot modify an existing user's libraries).
- Live TV and mobile-upload invite flags (stay off).
- Live-mode Stripe objects (existing go-live step).
