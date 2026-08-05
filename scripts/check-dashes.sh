#!/usr/bin/env bash
# Fail if an en dash or em dash appears in tracked source, docs, or config.
#
# House rule: no en dashes or em dashes in any content, including code
# comments and prose. Rephrase with commas, semicolons, parentheses, or
# periods. Used by `npm run lint:dashes`, which system-check runs at
# pre-commit.
#
# ALLOWLIST, two groups, both skipped wholesale. Keep prose in them dash-free
# by hand.
#   1. The admin tables render an em dash as the "no value" placeholder glyph
#      (a symbol, not punctuation, so there is nothing to rephrase).
#   2. The skills and agent that define this very rule have to display the
#      characters they ban, including one labelled BAD counter-example.
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW='^web/src/components/MembersTable/MembersTable\.(tsx|test\.tsx)$'
ALLOW+='|^web/src/pages/User/User\.(tsx|test\.tsx)$'
ALLOW+='|^\.claude/skills/wizteros-(commit|pr)-format/SKILL\.md$'
ALLOW+='|^\.claude/agents/wizteros-house-style-review\.md$'

# Built from UTF-8 octal escapes (U+2013, U+2014) so this script does not
# itself contain the characters it bans, and so it stays portable to bash 3.2.
DASHES="$(printf '\342\200\223\342\200\224')"

hits=0
while IFS= read -r f; do
  [[ "$f" =~ $ALLOW ]] && continue
  [ -f "$f" ] || continue
  if grep -Hn "[$DASHES]" "$f" 2>/dev/null; then
    hits=1
  fi
done < <(git ls-files)

if [ "$hits" -ne 0 ]; then
  echo "" >&2
  echo "✗ en/em dashes found (see above)." >&2
  echo "  Rephrase with commas, semicolons, parentheses, or periods." >&2
  exit 1
fi

echo "✓ no en/em dashes"
