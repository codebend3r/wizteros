#!/usr/bin/env bash
# Run ruff with the app venv, falling back to whatever ruff is on PATH (CI
# installs the requirements with plain pip, no venv). Backs the
# `fleet-monitor:lint:py` and `lint:py:fix` Nx targets.
set -euo pipefail
cd "$(dirname "$0")/.."

RUFF="$PWD/.venv/bin/ruff"
if [ ! -x "$RUFF" ]; then
  RUFF="$(command -v ruff)" || {
    echo "ruff not available - bootstrap the venv with: bun run setup:py:monitor" >&2
    exit 1
  }
fi

exec "$RUFF" check "$@" .
