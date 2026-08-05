#!/usr/bin/env bash
# Run ruff over the stripe-bridge package with the repo venv, falling back to
# the system python3. Mirrors test-bridge.sh. Used by `npm run lint:py` (and
# `lint:py:fix`), which the pre-commit hook runs via system-check.
#
# Pass --fix to apply ruff's safe autofixes.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$PWD/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

if ! "$PY" -m ruff --version >/dev/null 2>&1; then
  echo "ruff not available, bootstrap the venv with: bun run setup:py" >&2
  exit 1
fi

cd stripe-bridge
exec "$PY" -m ruff check . "$@"
