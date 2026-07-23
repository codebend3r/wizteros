#!/usr/bin/env bash
# Bump the root and web package versions in lockstep, commit as
# `WZ: Bump version to X.Y.Z`, and tag `vX.Y.Z`. npm skips its own git
# commit/tag for web/ because .git lives at the repo root, so this script
# owns the whole release flow. Used by `npm run release:{patch,minor,major}`.
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
  echo "working tree not clean — commit or stash first" >&2
  exit 1
fi

VERSION="$(npm version "$LEVEL" --no-git-tag-version | tr -d v)"
npm --prefix web version "$VERSION" --no-git-tag-version >/dev/null

git add package.json web/package.json
git commit -m "WZ: Bump version to $VERSION"
git tag "v$VERSION"

echo "tagged v$VERSION — publish with: git push origin main v$VERSION"
