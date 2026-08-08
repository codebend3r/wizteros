---
name: version-bumper
description: Use when deciding whether wizteros main is due for a version bump, or when asked "should we cut a release", "bump the version", "recommend a bump", "what version should this be", "is main ahead of the last release", or after PRs merge to main and a release feels due. Only applies to the wizteros repo.
---

# Version bumper for wizteros

## Overview

Reads `origin/main`, decides whether the unreleased commits warrant a version bump,
recommends a level (patch, minor, or major), and stops for a plain yes or no. On yes it
runs the repo's existing release flow.

`scripts/release.sh` owns the mechanics (lockstep bump of the three version markers, the
`WZ: Bump version to X.Y.Z` commit, the annotated `vX.Y.Z` tag). This skill owns the
judgment and never hand-edits a version field.

The three markers, which must always agree:

| Marker | Why |
|---|---|
| `package.json` | Workspace root, the source of truth |
| `apps/admin-portal/package.json` | The SPA |
| `apps/stripe-bridge/stripe_bridge/__init__.py` | `__version__`, the only marker that reaches the container |

`release.sh` hard-fails when they disagree, both before and after the bump, so a
mismatch is a stop-and-report, never something to patch by hand.

The bridge exposes its version at `GET /version` (and `/stripe/version` behind Funnel),
unauthenticated. That is the way to check which release the NAS is actually running.

Versions here are release bookkeeping for a private package with no downstream semver
consumers. That changes the calibration; see Picking the level.

## Finding the baseline

Always `git fetch origin --tags --prune` first, and evaluate `origin/main`, never the
local branch.

The baseline is the newest commit on `origin/main` whose subject is
`WZ: Bump version to X.Y.Z`:

```bash
git log origin/main --grep='^WZ: Bump version to' -1 --format='%H %s'
```

Do not use the newest `v*` tag as the baseline. Tags can lag the truth: the 0.1.5 bump
commit landed on main while `v0.1.5` sat unpushed, so the tag series read `v0.1.4` when
main was already on 0.1.5. That particular tag has since been backfilled, but the failure
mode is one forgotten `git push` away at any time. The bump commit is the truth.

Cross-checks before judging anything:

- All three version markers on `origin/main` must read the baseline version (they move in
  lockstep). Disagreement means a broken release; stop and report it instead of
  recommending. This is the check that the 1.0.x phantom went without: the root sat two
  majors ahead of the app for four consecutive tags. See `CHANGELOG.md`.
- If the baseline version's tag is missing from `git ls-remote --tags origin`, keep
  going, but fold the backfill into the recommendation:
  `git tag vX.Y.Z <bump-sha> && git push origin vX.Y.Z`.

## Judging the range

The unreleased range is `<baseline-sha>..origin/main`.

```bash
git log --oneline <baseline-sha>..origin/main
git log <baseline-sha>..origin/main --format='== %h %s' --stat
```

Split the commits into two piles:

- **Shipped surface**: anything that changes what runs in production.
  `apps/admin-portal/` (ships via Netlify from main), `apps/stripe-bridge/`, and the
  deploy config that alters the running stack (`docker-compose.yml`, `netlify.toml`,
  `apps/stripe-bridge/Dockerfile`).
- **Housekeeping**: `docs/`, `.github/`, `.claude/`, `scripts/` tooling, CI, test-only
  changes, and the monorepo wiring itself (`nx.json`, root `package.json` aliases,
  `apps/stripe-bridge/project.json` target definitions, `nx.includedScripts` in
  `apps/admin-portal/package.json`). Task plumbing changes how the repo is built, not
  what runs in production.

Living under an app root does not by itself make a file shipped surface. Three cases to
get right:

- `apps/admin-portal/package.json`: moves on every release by definition, so a diff
  touching only its `version` field is the bump commit, not shipped surface.
- `apps/stripe-bridge/tests/` and `apps/admin-portal/src/test/`: test-only, housekeeping.
  The runtime code is `apps/stripe-bridge/stripe_bridge/` and `apps/admin-portal/src/`.
- App-root config (`vite.config.ts`, `tsconfig.json`, `pytest.ini`, lint or format
  config): shipped surface only when it changes the built output. A lint-rule tweak is
  housekeeping; a Vite build or alias change is not.

Commits are the unit, and commits mix file classes: a commit with at least one
shipped-surface file goes in the shipped pile, whatever else it touches.

Recommend a bump when the shipped pile has at least one commit. A housekeeping-only pile
gets "no bump yet" plus a one-line note of what is waiting. An empty range gets "main is
fully released".

## Picking the level

House calibration, not textbook semver. History: 0.1.4 swallowed the admin login gate
and the new admin pages; 0.1.5 swallowed the React 19 upgrade and the mobile-ready
pages. Features and fixes both land as patch here.

| Level | When |
|---|---|
| patch | The routine release: any mix of fixes, features, upgrades, UI work. Default when torn. |
| minor | A deliberate milestone the admin must notice: payment-flow change, a store migration that needs admin action, auth overhaul, a new app surface. Additive schema (auto-created tables, `IF NOT EXISTS` columns) is routine and stays patch. Minor is a statement; use it sparingly. |
| major | 1.0 graduation, or a compatibility break with live NAS state or Stripe data. Flag it loudly and say why. |

## The recommendation

Present, in this order, then stop and wait for yes or no:

1. Current version and proposed version.
2. The commit list, split shipped vs housekeeping.
3. One or two lines of reasoning for the level.
4. Exactly what a yes triggers, spelled out: "Yes means: switch to main, pull, run
   `scripts/release.sh <level>` (commits and tags `vX.Y.Z`), write the `CHANGELOG.md`
   section and amend it into the bump commit, push main with the tag, and publish the
   GitHub Release." Include the tag backfill here when one is missing.

One yes covers that whole stated plan. Never re-ask per step (not for the branch
switch, not for the push); the plan was stated and consented to in one round. A no means
do nothing at all; nothing gets recorded anywhere.

This stop is the skill's contract, requested by the repo owner: one recommendation,
one plain yes or no. It is deliberate and does not count as the mid-task confirmation
the global autonomy rules forbid.

## On yes

1. Working tree must be clean (`release.sh` hard-fails otherwise). Report a dirty tree;
   never stash it away silently.
2. `git switch main && git pull --ff-only origin main`.
3. `bash scripts/release.sh <level>` from the repo root. It bumps all three markers,
   commits, and creates an annotated tag. It refuses to run off main (override with
   `RELEASE_ALLOW_BRANCH=1`) and refuses when the markers disagree.
4. Add the `## vX.Y.Z (YYYY-MM-DD)` section to `CHANGELOG.md`, written from the shipped
   pile, then `git add CHANGELOG.md && git commit --amend --no-edit` so the changelog
   travels in the bump commit rather than trailing it.
5. `git push origin main vX.Y.Z` (branch and tag in one push; a tag that stays local is
   what the `v0.1.5` lag looked like). If the recommendation included a tag backfill for
   an earlier version, create and push that tag here too; it is part of the consented
   plan, not a separate favor to ask about later.
6. `bash scripts/backfill-releases.sh --apply` to publish the GitHub Release from the
   changelog section. It skips versions that already have one, so it is safe to re-run.
7. Verify: `git ls-remote --tags origin` shows the new tag, all three markers read the new
   version, and `gh release view vX.Y.Z` returns the notes.
8. If the released range touched `apps/stripe-bridge/`, point at the deploy-nas skill as
   the follow-up, and confirm the deploy with `curl -s <bridge>/version` once it is done.
   `apps/admin-portal/` needs nothing; Netlify redeploys from main on its own.
9. Return to the branch the session started on if it was not main.

## Red flags

- Baseline taken from the newest `v*` tag: wrong whenever a tag was never pushed. The
  bump commit is the truth.
- Hand-editing a version field: never. `release.sh` owns the flow.
- Running `release.sh` anywhere but an up-to-date main: the bump commit lands on the
  wrong branch.
- "It has features, so minor": textbook semver, wrong here. Check the house calibration
  first.
- Re-asking for permission mid-flow after the yes: the stated plan was already consented
  to.
- Recommending a bump for a docs/CI-only pile: nothing shipped, nothing to version.
- Counting an Nx retarget (`nx.json`, `project.json`, root script aliases) as shipped
  surface: it changes how the repo builds, not what production runs.
- Bumping only the two `package.json` files: the bridge `__version__` is the third marker
  and the only one the running container can report. `release.sh` blocks this, so hitting
  it means someone edited a version by hand.
- Tagging a release without a `CHANGELOG.md` section: the tag then says nothing about what
  shipped, which is the state all eight pre-0.2.1 tags were in.
- Creating a lightweight tag by hand (`git tag vX.Y.Z`): the series is annotated from
  0.2.1 onward. Let `release.sh` make the tag.
- Assuming the NAS runs the newest release because main does: check `GET /version` on the
  bridge. Netlify auto-deploys, the NAS does not.
- Looking for `web/` or a top-level `stripe-bridge/`: both live under `apps/` since the
  monorepo conversion.
