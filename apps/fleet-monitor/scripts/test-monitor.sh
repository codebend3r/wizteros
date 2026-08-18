#!/usr/bin/env bash
# Run the fleet-monitor pytest suite with the app venv, falling back to the
# system python3 (CI installs the requirements with plain pip, no venv).
# Backs the `fleet-monitor:test` Nx target.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$PWD/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

if ! "$PY" -m pytest --version >/dev/null 2>&1; then
  echo "pytest not available - bootstrap the venv with: bun run setup:py:monitor" >&2
  exit 1
fi

exec "$PY" -m pytest -q
