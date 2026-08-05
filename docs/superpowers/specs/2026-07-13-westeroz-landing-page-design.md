# Westeroz landing page: design

Date: 2026-07-13
Status: Approved (pending spec review)

## Purpose

A public, static landing page hosted on Netlify at `westeroz.netlify.app` that
introduces the community media server and funnels visitors to a single Stripe
Payment Link. It is the public "front door"; the surface people read before they
contribute.

Everything else in the stack (Wizarr, Tautulli, stripe-bridge, Plex) stays
self-hosted on a Synology NAS and is exposed via Cloudflare Tunnel. That backend
work is **out of scope for this spec**: it is already covered by the existing
plan/spec docs under `docs/superpowers/`.

## Constraints

- **Framing (non-negotiable).** All user-facing copy uses infrastructure/hosting
  language. No reference to content, libraries, titles, or the underlying media
  platform anywhere on the page. This mirrors the `CLAUDE.md` rule and protects
  the contribution framing (Plex/Stripe TOS).
- **No secrets in the page.** Static site only. No API keys, no serverless
  functions, no calls into the home LAN. The only outbound links are the Stripe
  Payment Link and (later) the Wizarr member URL.
- **House conventions** (`CLAUDE.md`): TypeScript with type aliases only (no
  interfaces), no `any`, no type casts, prefer type guards and `unknown`.
  SCSS modules for component styles; `styles/globals.scss` holds design tokens
  and typographic primitives only. Container-driven layout, CSS grid with `gap`
  for spacing (avoid margins), flex as second choice. No bare divs. All
  colors/spacing/radius/type from tokens. Short-circuit (`&&`) rendering with a
  guarded boolean; optional chaining always paired with nullish coalescing.

## Scope

In scope:

- A single-page static site built with Vite + React + TypeScript + SCSS modules.
- One primary call-to-action linking to a configurable Stripe Payment Link.
- Env-swappable configuration so test → live is a one-line change (no code edit).
- Netlify deploy configuration.
- Component + config tests.

Out of scope:

- Backend hosting (NAS + Cloudflare Tunnel), Wizarr/Tautulli/bridge deployment.
- Stripe product/Payment Link creation, webhook wiring.
- Subscription tiers (single contribution only; the design leaves room to add
  tiers later without a rewrite).
- Custom domain beyond `westeroz.netlify.app`.

## Architecture

Single-page static site. Vite builds to `dist/`; Netlify serves the static
output. No backend, no serverless functions. The page holds no state beyond
its config object and renders three stacked sections.

```
Visitor ──> westeroz.netlify.app (static)
               │  Contribute CTA ──> Stripe Payment Link
               └  Member link     ──> Wizarr invite.<domain>  (when configured)
```

## Directory / component structure

```
src/
  main.tsx                 React root render
  App.tsx                  page composition (Hero, Support, Footer)
  site.config.ts           typed site config (see below)
  styles/globals.scss      design tokens + typographic primitives
  components/
    Hero/
      Hero.tsx             brand name, tagline, price, Contribute CTA
      Hero.module.scss
    Support/
      Support.tsx          "what your contribution covers" (infra items)
      Support.module.scss
    Footer/
      Footer.tsx           member sign-in link + framing disclaimer
      Footer.module.scss
```

Each component has one clear purpose, takes a typed props object, and can be
understood without reading its siblings.

## Configuration

A single typed config object is the source of truth for all copy and links.
`paymentLinkUrl` and `memberUrl` may be overridden at build time by Vite env
vars (set in the Netlify UI), so switching from the test Payment Link to the
live one: or enabling the member link once the tunnel is up, requires no code
change.

```ts
type SupportItem = {
  title: string
  detail: string
}

type SiteConfig = {
  brandName: string
  tagline: string
  priceLabel: string // operator-set, e.g. "$10 / month"
  paymentLinkUrl: string // Stripe Payment Link (test now, live later)
  memberUrl: string | null // Wizarr invite.<domain>; null hides the link
  supportItems: ReadonlyArray<SupportItem>
}
```

Resolution rules:

- `paymentLinkUrl` = `import.meta.env.VITE_PAYMENT_LINK_URL` when set, else the
  config default (the current test link).
- `memberUrl` = `import.meta.env.VITE_MEMBER_URL` when set, else `null`. When
  `null`, the member sign-in link does not render.
- `priceLabel` is operator-configured. Until the monthly amount is decided it
  ships as a `$X / month` placeholder; this is a deliberate config value, filled
  before launch, not an unresolved requirement.

## Content / copy

Infrastructure/hosting framing only. Indicative copy (final wording can be
adjusted during implementation, but must stay within the framing constraint):

- **Hero**
  - Brand: `Westeroz`
  - Tagline: "A community-run media server. Contribute to the cost of keeping it
    online."
  - Price: `priceLabel`
  - CTA button: "Contribute" → `paymentLinkUrl`
- **Support**: three items describing what the contribution covers:
  - **Server hardware**: "Always-on machines that host and stream the platform."
  - **Storage & bandwidth**: "Disks and network capacity that keep everything
    available."
  - **Maintenance & uptime**: "Updates, backups, and monitoring so it stays
    reliable."
- **Footer**
  - Member link (only when `memberUrl` is set): "Already contributing? Access
    your account →"
  - Disclaimer: "A contribution toward hosting and infrastructure costs, not a
    purchase of content."

## Styling

Dark, clean, modern; a restrained nod to the dragon naming theme (typographic /
color mood, not fantasy artwork). All design tokens (color, spacing, radius,
font sizes) defined in `styles/globals.scss` and consumed by the SCSS modules.
Layout is CSS grid with `gap`; the page container defines width, children
position within it. No margin-based spacing, no bare divs. Responsive: single
column on small screens, comfortable max-width container on large screens.

## Error / edge handling

- Missing `paymentLinkUrl` env override → falls back to the config default, so
  the CTA always has a destination.
- `memberUrl` unset → member link is simply not rendered (guarded boolean +
  short-circuit render). No broken link, no placeholder.
- The page has no runtime failure modes beyond a broken external link, which is
  an operator config concern, not a code path.

## Testing

Vitest + React Testing Library:

- The Contribute CTA renders and its `href` equals the resolved
  `paymentLinkUrl`.
- `priceLabel` renders in the Hero.
- The member sign-in link renders when `memberUrl` is set and is absent when it
  is `null`.
- Support section renders one entry per `supportItems`.

## Deploy

- `netlify.toml`: build command `npm run build`, publish directory `dist/`.
- Netlify site connected to the repo (or drag-and-drop of `dist/`), custom
  subdomain `westeroz.netlify.app`.
- Env vars `VITE_PAYMENT_LINK_URL` (and later `VITE_MEMBER_URL`) set in the
  Netlify UI; changing the Payment Link from test to live is a one-value edit +
  redeploy, no code change.

## Follow-ups (not this spec)

1. Set the monthly `priceLabel` amount.
2. Stand up the Cloudflare Tunnel + NAS deploy of Wizarr/Tautulli/bridge.
3. Create the live Stripe product + Payment Link + webhook endpoint; set
   `VITE_PAYMENT_LINK_URL` to the live link.
4. Once Wizarr is publicly reachable, set `VITE_MEMBER_URL` to enable the
   member sign-in link.
