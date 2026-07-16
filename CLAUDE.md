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

## Operator context (as of 2026-07-14)

- 5 Synology NASes on `192.168.50.0/24`, each running its own Plex server. Naming theme: Game of Thrones dragons. All 5 are connected to Wizarr (Caraxes, Meleys, Syrax, Vermithor, Vhagar).
- The management stack (Wizarr, Tautulli, stripe-bridge) runs on **Meleys** (`192.168.50.2`) under Container Manager, at `/volume1/docker/wizteros`. Deployed via SSH key auth for `crivas@192.168.50.2`; push code updates with `npm run deploy:nas` over the mounted `docker` SMB share.
- Wizarr is reachable internally; public ingress via Tailscale Funnel is the chosen path (see below).
- No custom domain in use — the operator is not purchasing one. This ruled out Cloudflare Tunnel (needs a domain) in favor of Tailscale Funnel.
- Public URL: `https://meleys.tail5586d4.ts.net` (Tailscale Funnel, live and verified).
- Stripe has exactly two environments: **Test mode** and **Live** — both under the "Westeroz" account. A third ("Westeroz sandbox") existed and was deleted on 2026-07-14; never create sandboxes again, they cause environment misalignment (keys/payment links/webhooks must all live in the same environment).
- GitHub: `codebend3r`. Repo is private.

## Planned tooling decisions

- Public reachability via **Tailscale Funnel** on the Meleys host — chosen over Cloudflare/ngrok because it needs no custom domain (free, stable `<node>.<tailnet>.ts.net` URL with real TLS). See `docs/tailscale-funnel.md`.
- One hostname, port 443, path-mounted: `/` -> `wizarr:5690`, `/stripe/webhook` -> `stripe-bridge:8000` (Funnel strips the `/stripe` prefix, so the bridge serves both `/stripe/webhook` and `/webhook`)
- Stripe Payment Links (no custom checkout), webhook events: `checkout.session.completed` + `invoice.paid` (renewals) + `customer.subscription.deleted`

## Conventions

- Secrets live in `.env` (gitignored). `.env.example` is the source of truth for variable names.
- Compose volumes: `./wizarr-data/` and `./tautulli-config/` are runtime state, also gitignored.
- Don't introduce a database for the bridge until cancellation-by-email is actually broken in practice.
- Don't add backwards-compatibility shims — this stack has no users yet outside the operator.

## What's done vs what's next

Done:

- Repo scaffolded, README + Dockerfile + compose + bridge committed
- All 5 Plex servers added in Wizarr
- DNS state on the domain verified clean (safe to migrate)
- Wizarr API key generated, `.env` filled
- Management stack migrated to Meleys NAS; core services (Wizarr, Tautulli, stripe-bridge) running there
- Chose Tailscale Funnel for public ingress (no domain); `cloudflared` removed from compose
- Tailscale Funnel live on Meleys: `/` -> Wizarr, `/stripe/webhook` -> bridge, verified publicly
- Stripe webhook endpoint, `PUBLIC_INVITE_BASE`, Netlify `VITE_MEMBER_URL` + `VITE_PAYMENT_LINK_URL` all pointed at `https://meleys.tail5586d4.ts.net` / the Test-mode payment link
- **End-to-end signup flow verified in Test mode (2026-07-14)**: real test checkout -> webhook -> invite email -> Wizarr join -> Plex OAuth, all passed
- **Four subscription tiers live in Test mode, verified per tier E2E (2026-07-16)**: Bronze $8 / Silver $14 / Gold $20 / Kids $20 CAD, payment-link `metadata.tier` -> tier-scoped Wizarr invites (`library_ids` + `allow_downloads`); private `9X.` Caraxes libraries excluded fail-closed everywhere. Gold verified by a real member join across all 5 servers; Kids twice (2 servers, 3 libraries); Bronze/Silver via signed synthetic webhooks. Wizarr needs `GUNICORN_TIMEOUT=600` (multi-server joins exceed the 120s default when plex.tv is slow); the bridge Dockerfile copies modules explicitly — new .py files must be added to its `COPY` line.

Next (in order):

1. (Optional) Verify the cancellation flow: cancel the test subscription in Stripe, confirm the bridge disables the Wizarr user
2. Decide on the legacy-share downgrade sweep (existing members who subscribe keep old out-of-tier Plex shares until expiry — see Max case, 2026-07-16) and tier-neutral wizard copy (default wizard says "all five servers", wrong for Kids/Bronze)
3. Switch to live: create live products/payment links with the same `metadata.tier` tags, live webhook endpoint (same URL/events), live `sk_live_` key + webhook secret in the NAS `.env`, point the four Netlify `VITE_PAYMENT_LINK_*_URL` vars at the live links, force-recreate the bridge
4. Announce to a small trusted group

See `docs/nas-deployment.md` (NAS migration) and `docs/tailscale-funnel.md` (public ingress).

## Typescript

- Always use type aliases. Never use TypeScript interfaces anywhere, including `declare global` augmentations; lint enforces this (`@typescript-eslint/consistent-type-definitions`).
- Use type guards wherever possible.
- Never use `any` types; prefer type narrowing or type guards
- Never under any circumstance cast types and never double cast: `as any as string`
- If type can't be inferred and type narrowing is not an option, use `unknown` types

## CSS

- Use SCSS modules (`*.module.scss`) for component styles
- Only use global stylesheets (`styles/globals.scss`) for design tokens and true typographic primitives
- Use a container driven approach, meaning the container will define the width and height and the children will be positioned within it, this means if/when the children are moved to different containers they may be laid out differently depending on what the container specificies
- Prefer using CSS display grid for layout with the gap property for spacing between grid items; avoid using margins for spacing
- Second preferred display value is flex
- Avoid using plain divs; meaing divs with no class or id defined
- Always use token values from `styles/globals.scss` when defining font sizes, colors, and other design tokens like padding, margin, gap, and border radius

## Code style

- Prefer `reduce` over `for` loops when possible. Never use `for/in` or `for/of` loops; reach for `Array.prototype` methods (`map`, `filter`, `reduce`, `flatMap`, etc.) when the value is an array.
- Prefer double-bang (`!!value`) for boolean conversion.
- Prefer short-circuit (`&&`) over a ternary when the else branch is `null` or `undefined`, especially in React rendering. Do: `{isActive && <Badge />}`. Don't: `{isActive ? <Badge /> : null}`. Guard the condition so it is a real boolean (`!!count && ...`), never a bare number that could render `0`.
- Prefer optional chaining (`?.`). When optional chaining is used, ALWAYS pair it with nullish coalescing (`??`) to supply a fallback.
- Prefer a single configurable object parameter over multiple positional parameters so argument order doesn't matter. Don't: `doSomething(foo, bar, hello)`. Do: `doSomething({ foo, bar, hello })`.

## Commits

- Create a commit after every logical change, batch if they are related.
- Subject must start with `WZ:` followed by a short title (e.g., `WZ: a short title`).
- Favor bullet points in the body. Keep it concise and easy to read.
