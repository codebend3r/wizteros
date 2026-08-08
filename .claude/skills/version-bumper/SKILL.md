---
name: version-bumper
description: Use when deciding whether wizteros main is due for a version bump, or when asked "should we cut a release", "bump the version", "recommend a bump", "what version should this be", "is main ahead of the last release", or after PRs merge to main and a release feels due. Only applies to the wizteros repo.
---

# Version bumper for wizteros

## Overview

Reads `origin/main`, decides whether the unreleased commits warrant a version bump,
recommends a level (patch, minor, or major), and stops for a plain yes or no. On yes it
runs the repo's existing release flow.

`scripts/release.sh` owns the mechanics (lockstep bump of the workspace root and
`apps/admin-portal/package.json`, the `WZ: Bump version to X.Y.Z` commit, the `vX.Y.Z`
tag). This skill owns the judgment and never hand-edits a version field.

`apps/stripe-bridge/` is Python and has no `package.json`, so it carries no version of
its own; the root version covers the whole workspace.

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
commit landed on main but `v0.1.5` was never pushed, so the tag series stopped at
`v0.1.4` while main was on 0.1.5.

Cross-checks before judging anything:

- `package.json` and `apps/admin-portal/package.json` on `origin/main` must both read the
  baseline version (they move in lockstep). Disagreement means a broken release; stop and
  report it instead of recommending.
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
   `scripts/release.sh <level>` (commits and tags `vX.Y.Z`), and push main with the
   tag." Include the tag backfill here when one is missing.

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
3. `bash scripts/release.sh <level>` from the repo root.
4. `git push origin main vX.Y.Z` (branch and tag in one push; the missing `v0.1.5` is
   what forgetting the tag looks like). If the recommendation included a tag backfill
   for an earlier version, create and push that tag here too; it is part of the
   consented plan, not a separate favor to ask about later.
5. Verify: `git ls-remote --tags origin` shows the new tag, and both package.json files
   read the new version.
6. If the released range touched `apps/stripe-bridge/`, point at the deploy-nas skill as
   the follow-up. `apps/admin-portal/` needs nothing; Netlify redeploys from main on its
   own.
7. Return to the branch the session started on if it was not main.

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
- Looking for `web/` or a top-level `stripe-bridge/`: both live under `apps/` since the
  monorepo conversion.
