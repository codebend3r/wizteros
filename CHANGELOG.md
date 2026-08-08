# Changelog

All notable changes to wizteros, one section per released tag, newest first.

Versions here are release bookkeeping for a private stack with no downstream
semver consumers, so features and fixes both land as patch. Minor marks a
milestone the admin has to notice. See `.claude/skills/version-bumper/SKILL.md`
for the calibration.

Read [Version history anomalies](#version-history-anomalies) before trusting the
early tags; four of them disagree with the version recorded in the tree.

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
- Adopt oxlint, oxfmt, gale and tsgo (#15)
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

First tag whose name matches the version recorded in the tree.

- Add an allow-downloads toggle to the member page (#6)
- Rebrand the kids tier to youth (#5)
- Reset the root package version to the real 0.1.x line, ending the 1.0.x phantom
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

## v0.1.0 (never tagged)

The web app was scaffolded at version `0.1.0` in `08a91ee` and carried that
version until the `0.1.1` bump. No `v0.1.0` tag was ever created, and none has
been backfilled: `0.1.0` spanned a window rather than a single release commit,
and the only candidate commit predates `v0.0.2`, so tagging it would put the
tag series out of version order. The hole between `v0.0.2` and `v0.1.1` is
deliberate and permanent. Its contents are listed under v0.0.2 and v0.1.1.

## v0.0.2 (2026-07-13)

Tagged retroactively on 2026-07-22. The tree recorded `1.0.2` at this commit;
see [Version history anomalies](#version-history-anomalies).

- Scaffold the Westeroz landing page (Vite + React + TS) from a design spec
- Compose the landing page from Hero, Support, and Footer sections
- Add env-swappable site config
- Set the contribution price to $8 per month
- Darken the CTA accent for WCAG AA contrast
- Add Netlify config and landing page docs

## v0.0.1 (2026-07-13)

Initial release. Tagged retroactively on 2026-07-22. The tree recorded `1.0.1`
at this commit.

- Scaffold the Wizarr + Tautulli + Stripe bridge stack
- Implement the stripe-bridge paid-access service
- Add the stripe-bridge test suite and e2e harness

## Version history anomalies

Recorded here because the tag names, the commit subjects, and the versions in
the tree disagree for the first four releases, and nothing else in the repo
explains why.

**The 1.0.x phantom.** Two accidental `npm version` runs pushed the root
`package.json` to `1.0.1` and then `1.0.2`. The commits still carry the subjects
`WZ: Bump version to 1.0.1` and `WZ: Bump version to 1.0.2`. The tags placed on
them say `v0.0.1` and `v0.0.2`. The root stayed at `1.0.2` through `v0.1.1` and
`v0.1.2` as well, so for four consecutive tags the tag name and the recorded
version disagreed. `563346b` reset the root to `0.1.2`, and `v0.1.3` is the
first tag where the two agree. The commit subjects were left alone rather than
rewriting published history.

**Root and app were out of lockstep until v0.1.3.** At `v0.1.1` the root read
`1.0.2` while the web app read `0.1.1`; same shape at `v0.1.2`. They have moved
together since, and `scripts/release.sh` now refuses to release when the markers
disagree.

**Tag creation order is not version order.** `v0.0.1`, `v0.0.2`, `v0.1.1`, and
`v0.1.2` were all created on 2026-07-22, in the order `v0.1.1`, `v0.1.2`,
`v0.0.1`, `v0.0.2`. Sorting tags by creation date therefore lists the `0.0.x`
pair last. Sort by version (`git tag --sort=v:refname`) or by commit date.

**Two tag types.** `v0.0.1` through `v0.1.2` are annotated tag objects;
`v0.1.3` through `v0.2.0` are lightweight and carry no tagger or message.
`scripts/release.sh` creates annotated tags, so `v0.2.0` is the last lightweight
one. The existing tags were left as they are; retagging them would rewrite refs
that are already published.

**Early tagging cadence was uneven.** `v0.0.2..v0.1.1` spans 42 commits and
`v0.1.1..v0.1.2` spans 30, against 5 to 10 commits per tag from `v0.1.2` onward.
The early tags are too coarse to be useful rollback points.
