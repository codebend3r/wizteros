# Changelog

All notable changes to wizteros, one section per released tag, newest first.

Versions here are release bookkeeping for a private stack with no downstream
semver consumers, so features and fixes both land as patch. Minor marks a
milestone the admin has to notice. See `.claude/skills/version-bumper/SKILL.md`
for the calibration.

Every tag is annotated, sits on a `WZ: Bump version to X.Y.Z` commit, and matches
the version recorded in the tree at that commit. That was not always true; the
history was rewritten on 2026-08-08 to make it so. See
[The 2026-08-08 history rewrite](#the-2026-08-08-history-rewrite).

## v0.3.3 (2026-09-03)

- Recover access after a failed payment: `invoice.payment_failed` and
  `customer.subscription.updated` now land behind a new `payment_state` column,
  so access is never revoked while Stripe retries, and `invoice.paid` clears the
  flag, issues a tier-scoped invite when nothing resolves to extend, and alerts
  the operator instead of returning on a lone warning
- Link a member's paying address to the account they watch with: a
  `member_links` table, `POST /admin/link-address`, and a "same person" action
  beside the duplicate badge, honored by the renewal, cancel, and expiry paths
  so one person stops reading as two rows
- Keep a member's access when only one of their subscriptions ends, and never
  let a cancelled subscription take a VIP's access; a sweep alarm now mails when
  a VIP holds no records at all
- Stop the expiry sweep passing over members it can never anchor: re-anchor at
  the sweep when the signup window has already lapsed, never stamp a past date,
  and resolve records through `member_links`
- Close the expiry gap for members whose Plex address differs from their Stripe
  one, by falling back to the redeemed invite's `used_by`; the invite email now
  asks new members to create their Plex account with the address it was sent to
- Resolve Wizarr `used_by` reprs (`<User 281>`) to real member records, so
  redeemed invites resolve again in the bridge and in the `member-triage` and
  `stripe-reconcile` skill scripts
- Make a duplicated email resolve to one predictable customer row: a real `cus_`
  row outranks an admin placeholder, and the newest checkout wins among real ones
- Widen gold to every shareable library on Meleys, Vermithor, Vhagar and Syrax,
  and retire Caraxes outright behind `RETIRED_SERVERS`, so no tier can resolve
  one of its libraries
- Stop minting invite links Wizarr never expires (#51): Wizarr honors only
  `{1, 7, 30}` day expiries and silently falls back to "never", so an unhonored
  value now snaps up to the next honored one and logs the substitution
- Show payment failures and dual addresses on the admin pages: a Payment Failed
  status with its own filter pill on `/manage`, a Stripe address shown only when
  it differs from the Plex one, and a possible-duplicate badge for two addresses
  one edit apart or the same Gmail mailbox written with dots or a `+tag`
- Keep the members search in the url (#53), so a refresh, a bookmark, or a
  pasted `?search=` link lands on the same filtered list
- Add a second oxlint and oxfmt pair at the repo root (#52), covering the 15
  `.mjs` files under `scripts/` and `.claude/skills/`, the docs, and the root
  config files that nothing linted or formatted before
- Document the billing-failure runbook in `docs/billing-failures.md`, the sweep
  fallback in `docs/invite-flow.md`, and fleet-monitor in CLAUDE.md
- Match youth libraries by title in the tiers e2e, so regrouping the Plex
  libraries renumbers them without breaking the expectation

## v0.3.2 (2026-08-30)

- Rebuild the fleet host card: band it into identity, readings, and inventory,
  tint the name band with the host's series colour, meter the capacity
  readings, and move GPU and containers into a footer so every card shows the
  same four readings
- Hold the chart panel's shape while a kind or range has no cached payload, so
  switching tabs or ranges no longer collapses the panel and jumps the page
- Read the fleet chart against the clock: a 15 minute range, quarter-hour x
  axis labels, a dated tooltip, and the newest reading's age reported only
  once the collector is actually late

This tag was cut by a bare `npm version` outside `scripts/release.sh`, so it
sits on a commit that bumped only the root marker and predates this section;
the admin-portal and bridge markers caught up in a follow-up commit. It is the
one exception to the tag invariant above.

## v0.3.1 (2026-08-28)

- Chart the fleet over time: the collector now serves per-host CPU busy history
  (up to a week), and the `/fleet` page renders it per second across pickable
  ranges with per-host colours, an update-rate slider, and preferences persisted
  in a zustand store
- Add memory, GPU, and network charts beside CPU, selected by tabs, with
  per-metric scaling and copy
- Gate the fleet API behind the admin Supabase session: the collector verifies
  the session itself, the portal sends it with every read, and cross-origin
  reads are allowed so the Netlify-hosted portal can reach the NAS
- Deploy the fleet monitor beside the bridge on the NAS via `docker-compose.yml`
  and `scripts/deploy-nas.sh`
- Let an admin page opt out of the hard refresh, so the fleet page keeps its
  chart state
- Widen the fleet grid with a new wide max-width token, and fix the chart
  tooltip box and axis typography
- Replace gale with stylelint for SCSS linting, and run lint-staged against the
  files in the commit with per-app configs

## v0.3.0 (2026-08-23)

- Add the fleet-monitor app and fleet overview page (#46): a new Python service
  (`apps/fleet-monitor/`) that probes the five Synology hosts over SSH for
  system, process, and Docker state, rolls the samples up, and raises incidents,
  plus a `/fleet` page in the portal that renders it
- Harden fleet-monitor and move host judgments server-side (#49): health verdicts
  are now decided by the collector rather than the browser, so every client reads
  the same call
- Add the annual pricing preview and lead with the tiers (#48): a billing-period
  toggle, an annual preview page, and a landing page reordered to open on the
  tiers
- Ledger follows the selected tier (#45): the StatusBoard ledger now tracks the
  tier the visitor has selected instead of holding a fixed one
- Match the youth allowlist on library titles (#47): the youth tier resolves
  libraries by title with the `NN. ` ordering prefix stripped, so renumbering the
  Plex libraries no longer silently empties the tier

## v0.2.2 (2026-08-14)

- Implement the Marquee Ledger redesign (#44): refreshed Hero, Pricing, Footer,
  Support, User, and Manage surfaces, a new StatusBoard component, and a Design
  reference page
- Rotate and audit the baseline invitations (#43): the bridge now owns the four
  per-tier baseline invite links, rotating them daily and persisting them in the
  store

## v0.2.1 (2026-08-08)

- Keep tier card copy on infrastructure language (#40): feature rows and tier
  summaries now describe playback capability (resolution, audio, downloads,
  request queue) instead of naming libraries or catalog scope
- Track the release version in the bridge and expose it at `GET /version`, so
  the deployed container can report which release it is running

## v0.2.0 (2026-08-08)

Minor: the repository layout changed underneath both apps.

- Convert the repository to an Nx monorepo over bun workspaces (#31), moving
  `web/` to `apps/admin-portal/` and the bridge to `apps/stripe-bridge/`
- Share every tier from Meleys only and stop duplicate invites (#20)
- Split the NAS stack into two compose projects
- Add a version-bumper skill (#21) and a deploy-nas skill for the bridge
- Add a sanity-check workflow for merges to main

## v0.1.5 (2026-08-01)

- Mobile-ready pages and a warm admin snapshot (#18)
- Stripe customer links and a clean test suite (#16)
- Adopt oxlint, oxfmt, gale and tsgo (#15); gale was later dropped and SCSS
  linting moved back to stylelint
- Package the bridge, consolidate docs, bump React 19 (#14)
- Bump Netlify Node to 24 (#13)

## v0.1.4 (2026-07-27)

- Gate the admin pages behind a Supabase login (#8)
- Add the admin side menu and live plex.tv access (#7)
- Fix paid expiry windows and show real server and library counts (#12)
- Decouple Invited status from a real payment signal (#10)
- Migrate tooling to Bun and add VIP email copy buttons (#9)
- Show the invite date and its 14 day window on the member page
- Keep the test env hermetic against a local `.env`
- Add release scripts for version bumps

## v0.1.3 (2026-07-23)

- Add an allow-downloads toggle to the member page (#6)
- Rebrand the kids tier to youth (#5)
- Update deployment docs for the Stripe live switch

## v0.1.2 (2026-07-21)

- Add an `/invite` page for inviting a brand-new person (#4)
- Add a CI workflow for lint, web, and bridge checks on every push
- Keep access through the invite window and add a 14-day grace status
- Overhaul the `/user` member detail page: per-member action history, hard tier
  reset, datetime expiry controls, confirmation on every member-changing action
- Add member libraries and notes to the admin API, rendered as pills with counts
- Share the admin header and footer across all admin pages
- Email the invite link on admin reissue, and keep re-invited members on `/manage`
- Set the brand wordmark in Lily Script One; show the mascot logo in the header
- Normalize tier cards into a fixed feature checklist, relabel kids as Youth,
  drop Youth to $10, and widen the desktop layout to 80rem

## v0.1.1 (2026-07-17)

- Show all members, overhaul `/manage`, add the `/user` detail page (#3)
- Add `/manage` and `/reset-user` admin pages (#2)
- Scope checkout invites by subscription tier, with a tier rules module and
  library scoping in `WizarrClient`
- Replace the single price CTA with four pricing cards
- Style the invite email with a branded HTML template
- Switch public ingress from Cloudflare Tunnel to Tailscale Funnel, and serve
  the webhook at `/webhook` as well as `/stripe/webhook`
- Reset existing members at checkout for re-join
- Migrate the web app to bun with exact dependency versions
- Add ESLint, Prettier, and husky pre-commit and pre-push hooks
- Use the `@/` alias for all web TypeScript imports

## v0.1.0 (2026-07-13)

Opens the 0.1.x line that carried the Westeroz landing page. This tag and its
bump commit were added by the 2026-08-08 history rewrite; the original history
jumped from `v0.0.2` straight to `v0.1.1`, leaving the landing-page work
untagged. The release itself is a version bump only, so its contents are the
42 commits that follow it, listed under v0.1.1.

## v0.0.2 (2026-07-13)

- Scaffold the Westeroz landing page (Vite + React + TS) from a design spec
- Compose the landing page from Hero, Support, and Footer sections
- Add env-swappable site config
- Set the contribution price to $8 per month
- Darken the CTA accent for WCAG AA contrast
- Add Netlify config and landing page docs

## v0.0.1 (2026-07-13)

Initial release.

- Scaffold the Wizarr + Tautulli + Stripe bridge stack
- Implement the stripe-bridge paid-access service
- Add the stripe-bridge test suite and e2e harness

## The 2026-08-08 history rewrite

Every commit on `main` was rewritten on 2026-08-08 and every tag was recreated.
**Clones made before that date share no commits with the current `main`**; the
fix is a fresh clone, or `git fetch origin && git reset --hard origin/main` on a
branch with nothing worth keeping.

What was wrong, and what the rewrite did:

**The 1.0.x phantom.** Two accidental `npm version` runs had pushed the root
`package.json` to `1.0.1` and then `1.0.2`, while the tags placed on those
commits said `v0.0.1` and `v0.0.2`. The root stayed at `1.0.2` through `v0.1.1`
and `v0.1.2` as well, so for four consecutive tags the tag name and the recorded
version disagreed, and the bump commits carried subjects naming versions that
were never released. The rewrite set those trees to `0.0.1` and `0.0.2` and
corrected the two commit subjects. The commit that had reset the root to `0.1.2`
became a no-op once the phantom was gone and was dropped.

**`v0.1.0` did not exist.** The web app was scaffolded at `0.1.0` and carried
that version until the `0.1.1` bump, but no tag was ever cut, so the series
jumped from `v0.0.2` to `v0.1.1`. The rewrite inserts a real
`WZ: Bump version to 0.1.0` commit after `v0.0.2` and tags it.

**Root and app were out of lockstep until `v0.1.3`.** At `v0.1.1` the root read
`1.0.2` while the web app read `0.1.1`; same shape at `v0.1.2`. The rewrite moves
every version marker together at every bump commit, including `package-lock.json`
where it still existed, so lockstep now holds from `v0.0.1` onward.
`scripts/release.sh` refuses to release when the markers disagree.

**Tag creation order was not version order.** `v0.0.1`, `v0.0.2`, `v0.1.1`, and
`v0.1.2` had all been created on 2026-07-22, in the order `v0.1.1`, `v0.1.2`,
`v0.0.1`, `v0.0.2`, so sorting by creation date put the `0.0.x` pair last. Each
tag is now stamped with its own commit's date, so creation order, version order,
and commit order agree.

**Two tag types.** `v0.0.1` through `v0.1.2` were annotated; `v0.1.3` through
`v0.2.0` were lightweight and carried no tagger or message. All nine are now
annotated, and `scripts/release.sh` only ever creates annotated tags.

**Early tagging cadence was uneven, and still is.** `v0.1.0..v0.1.1` spans 42
commits and `v0.1.1..v0.1.2` spans 30, against 4 to 10 commits per tag from
`v0.1.2` onward. That is real history, not bookkeeping, so the rewrite left it
alone; those early tags remain too coarse to be useful rollback points.
