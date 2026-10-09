#!/usr/bin/env bash
# Bump every version marker in lockstep, commit as `WZ: Bump version to X.Y.Z`,
# and tag `vX.Y.Z`. npm skips its own git commit/tag for the packages because
# .git lives at the repo root, so this script owns the whole release flow. Used
# by `bun run release:{patch,minor,major}`.
#
# The markers are every package.json in the workspace, as listed by
# scripts/version-markers.mjs: the root (the source of truth), then each package
# under apps/ and libs/. apps/stripe-bridge/package.json is the only one that
# reaches a container, and is what the bridge's GET /version reports. bun.lock
# records each workspace package's version too, so it moves with them.
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:?usage: release.sh patch|minor|major}"
case "$LEVEL" in
  patch | minor | major) ;;
  *)
    echo "usage: release.sh patch|minor|major" >&2
    exit 1
    ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree not clean; commit or stash first" >&2
  exit 1
fi

# The bump commit has to land on main; releasing from a feature branch is how a
# version ends up tagged on a commit that never shipped. Escape hatch for the
# rare deliberate case.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ] && [ "${RELEASE_ALLOW_BRANCH:-}" != "1" ]; then
  echo "on '$BRANCH', not main; release from main, or set RELEASE_ALLOW_BRANCH=1" >&2
  exit 1
fi

MARKERS="$(node scripts/version-markers.mjs)"

# Preflight: every marker must already agree. Drift here is what produced the
# 1.0.x phantom, where the root sat two majors ahead of the app for four
# consecutive tags before anyone noticed. See CHANGELOG.md.
if ! node scripts/version-markers.mjs --check >/dev/null; then
  echo "fix the version markers to match before releasing" >&2
  exit 1
fi

VERSION="$(npm version "$LEVEL" --no-git-tag-version | tr -d v)"
echo "$MARKERS" | tail -n +2 | while read -r marker; do
  npm --prefix "$(dirname "$marker")" version "$VERSION" --no-git-tag-version >/dev/null
done

# bun.lock carries each workspace package's version; refresh only those. Any
# other line moving means the lockfile had drifted from the manifests, which is
# not a release's business to fix.
bun install --lockfile-only >/dev/null
STRAY_LOCK_LINES="$(git diff -U0 bun.lock | grep -E '^[+-] ' | grep -vE '^[+-] +"version": "' || true)"
if [ -n "$STRAY_LOCK_LINES" ]; then
  {
    echo "bun.lock changed beyond workspace versions; nothing committed:"
    echo "$STRAY_LOCK_LINES"
    echo "Restore with: git checkout -- ."
  } >&2
  exit 1
fi

# Postflight: never tag a release whose markers did not all move.
if ! node scripts/version-markers.mjs --check "$VERSION" >/dev/null; then
  echo "bump did not apply cleanly to every marker; nothing committed. Restore with: git checkout -- ." >&2
  exit 1
fi

# shellcheck disable=SC2086 # one manifest path per line, none with spaces
git add $MARKERS bun.lock
git commit -m "WZ: Bump version to $VERSION"
# Annotated, never lightweight. The whole series is annotated as of the
# 2026-08-08 history rewrite; a lightweight tag would carry no tagger or
# message and break that.
git tag -a "v$VERSION" -m "v$VERSION"

echo "tagged v$VERSION (annotated)"
echo "next: add the v$VERSION section to CHANGELOG.md, amend it into the bump commit,"
echo "      move the tag onto the amended commit: git tag -fa v$VERSION -m v$VERSION"
echo "      then publish with: git push origin main v$VERSION"
