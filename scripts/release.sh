#!/usr/bin/env bash
# Bump the workspace root, apps/admin-portal, and apps/stripe-bridge versions in
# lockstep, commit as `WZ: Bump version to X.Y.Z`, and tag `vX.Y.Z`. npm skips its
# own git commit/tag for the app because .git lives at the repo root, so this
# script owns the whole release flow. Used by `bun run release:{patch,minor,major}`.
#
# Three version markers move together:
#   package.json                                  workspace root, the source of truth
#   apps/admin-portal/package.json                the SPA
#   apps/stripe-bridge/stripe_bridge/__init__.py  the only marker that reaches the container
set -euo pipefail
cd "$(dirname "$0")/.."

BRIDGE_INIT="apps/stripe-bridge/stripe_bridge/__init__.py"

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

read_json_version() { node -p "require('./$1').version"; }
read_bridge_version() { sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$BRIDGE_INIT"; }

# Preflight: all three markers must already agree. Drift here is what produced
# the 1.0.x phantom, where the root sat two majors ahead of the app for four
# consecutive tags before anyone noticed.
ROOT_BEFORE="$(read_json_version package.json)"
WEB_BEFORE="$(read_json_version apps/admin-portal/package.json)"
BRIDGE_BEFORE="$(read_bridge_version)"

if [ "$ROOT_BEFORE" != "$WEB_BEFORE" ] || [ "$ROOT_BEFORE" != "$BRIDGE_BEFORE" ]; then
  {
    echo "version markers disagree; fix them to match before releasing:"
    echo "  package.json                 $ROOT_BEFORE"
    echo "  apps/admin-portal            $WEB_BEFORE"
    echo "  stripe_bridge/__init__.py    $BRIDGE_BEFORE"
  } >&2
  exit 1
fi

VERSION="$(npm version "$LEVEL" --no-git-tag-version | tr -d v)"
npm --prefix apps/admin-portal version "$VERSION" --no-git-tag-version >/dev/null

# Portable in-place edit: BSD and GNU sed disagree on -i, so write and move.
sed "s/^__version__ = \".*\"$/__version__ = \"$VERSION\"/" "$BRIDGE_INIT" >"$BRIDGE_INIT.tmp"
mv "$BRIDGE_INIT.tmp" "$BRIDGE_INIT"

# Postflight: never tag a release whose markers did not all move.
ROOT_AFTER="$(read_json_version package.json)"
WEB_AFTER="$(read_json_version apps/admin-portal/package.json)"
BRIDGE_AFTER="$(read_bridge_version)"
if [ "$ROOT_AFTER" != "$VERSION" ] || [ "$WEB_AFTER" != "$VERSION" ] || [ "$BRIDGE_AFTER" != "$VERSION" ]; then
  {
    echo "bump did not apply cleanly to every marker; nothing committed:"
    echo "  package.json                 $ROOT_AFTER"
    echo "  apps/admin-portal            $WEB_AFTER"
    echo "  stripe_bridge/__init__.py    $BRIDGE_AFTER"
    echo "expected $VERSION everywhere. Restore with: git checkout -- ."
  } >&2
  exit 1
fi

git add package.json apps/admin-portal/package.json "$BRIDGE_INIT"
git commit -m "WZ: Bump version to $VERSION"
# Annotated, not lightweight: v0.1.3 through v0.2.0 are lightweight and carry no
# tagger or message, which makes the series inconsistent to read and to sort.
# Everything from here forward is annotated.
git tag -a "v$VERSION" -m "v$VERSION"

echo "tagged v$VERSION (annotated)"
echo "next: add the v$VERSION section to CHANGELOG.md, amend it into the bump commit,"
echo "      then publish with: git push origin main v$VERSION"
