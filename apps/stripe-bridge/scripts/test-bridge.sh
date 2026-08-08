#!/usr/bin/env bash
# Run the stripe-bridge pytest suite with the app venv, falling back to the
# system python3 (CI installs the requirements with plain pip, no venv).
# Backs the `stripe-bridge:test` Nx target, which `bun run test:bridge`,
# `bun run verify` and the pre-push hook all go through.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$PWD/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

if ! "$PY" -m pytest --version >/dev/null 2>&1; then
  echo "pytest not available - bootstrap the venv with: bun run setup:py" >&2
  exit 1
fi

exec "$PY" -m pytest -q
