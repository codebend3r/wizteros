#!/usr/bin/env bash
# Create a GitHub Release for every vX.Y.Z tag that does not have one, using that
# version's section of CHANGELOG.md as the release notes.
#
# Without this, the only description of what shipped in a version is its
# one-line bump commit subject. This closes that.
#
# Dry run by default; pass --apply to actually create the releases. Existing
# releases are never touched, so re-running is safe and only fills what is missing.
set -euo pipefail
cd "$(dirname "$0")/.."

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

if [ "$APPLY" = 1 ] && ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated; run: gh auth login" >&2
  exit 1
fi

# Ascending, so the newest tag is created last and ends up flagged latest.
TAGS="$(git tag -l 'v*' --sort=v:refname)"
NEWEST="$(echo "$TAGS" | tail -1)"

section_for() {
  # Print the CHANGELOG block for "## $1 (" up to the next "## " heading.
  awk -v tag="$1" '
    $0 ~ "^## " tag " \\(" { inside = 1; next }
    inside && /^## / { exit }
    inside { print }
  ' CHANGELOG.md
}

created=0
skipped=0

for tag in $TAGS; do
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "skip   $tag (release already exists)"
    skipped=$((skipped + 1))
    continue
  fi

  notes="$(section_for "$tag")"
  if [ -z "$(echo "$notes" | tr -d '[:space:]')" ]; then
    echo "skip   $tag (no CHANGELOG section found)" >&2
    skipped=$((skipped + 1))
    continue
  fi

  latest_flag="--latest=false"
  [ "$tag" = "$NEWEST" ] && latest_flag="--latest"

  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$notes" |
      gh release create "$tag" --title "$tag" --notes-file - --verify-tag "$latest_flag"
    echo "create $tag"
  else
    echo "would create $tag ($latest_flag)"
  fi
  created=$((created + 1))
done

echo
if [ "$APPLY" = 1 ]; then
  echo "created $created release(s), skipped $skipped"
else
  echo "dry run: $created release(s) would be created, $skipped skipped"
  echo "re-run with --apply to create them (this publishes to GitHub)"
fi
