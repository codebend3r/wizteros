#!/usr/bin/env bash
# Run the stripe-bridge pytest suite with the repo venv, falling back to the
# system python3. Used by `npm run test:bridge` and the pre-push hook.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$PWD/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

if ! "$PY" -m pytest --version >/dev/null 2>&1; then
  echo "pytest not available — bootstrap the venv with: npm run setup:py" >&2
  exit 1
fi

cd stripe-bridge
exec "$PY" -m pytest -q
