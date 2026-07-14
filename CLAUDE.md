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

- 5 Synology NASes on `192.168.50.0/24`, each running its own Plex server. Naming theme: Game of Thrones dragons. All 5 are connected to Wizarr (Caraxes, Meleys, Syrax, Vermithor, Vhagar).
- The management stack (Wizarr, Tautulli, stripe-bridge, cloudflared) runs on **Meleys** (`192.168.50.2`) under Container Manager, at `/volume1/docker/wizteros`. Deployed via SSH key auth for `crivas@192.168.50.2`; push code updates with `npm run deploy:nas` over the mounted `docker` SMB share.
- Wizarr is reachable internally; no public hostname yet.
- A domain is registered at name.com with default name.com nameservers. No live DNS records — Titan Email Premium subscription is attached but never configured (paid through 2027-01-30). Migration to Cloudflare is the planned path.
- GitHub: `codebend3r`. Repo is private.

## Planned tooling decisions

- Public reachability via **Cloudflare Tunnel** (chosen over ngrok and Tailscale Funnel for stable URLs at no recurring cost, plus real TLS certs via Cloudflare)
- Subdomains: `invite.<domain>` -> `wizarr:5690`, `webhook.<domain>` -> `stripe-bridge:8000`
- Stripe Payment Links (no custom checkout), webhook events: `checkout.session.completed` + `customer.subscription.deleted`

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
- `cloudflared` service added to `docker-compose.yml` (token-managed; awaiting tunnel token)

Next (in order):
1. Add the domain to Cloudflare, swap nameservers at name.com
2. Create Cloudflare Tunnel, set `TUNNEL_TOKEN` in `.env`, start cloudflared, route `invite.<domain>` -> `wizarr:5690` and `webhook.<domain>` -> `stripe-bridge:8000`
3. Point Stripe webhook, Netlify `VITE_MEMBER_URL`, and `PUBLIC_INVITE_BASE` at the tunnel
4. Test end-to-end with Stripe CLI (`stripe trigger ...`) in test mode
5. Switch to Stripe live keys, announce to a small trusted group

See `docs/nas-deployment.md` for the full NAS + tunnel runbook.

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
