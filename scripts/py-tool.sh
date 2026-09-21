#!/usr/bin/env bash
# Run ruff or pytest for one Python app out of that app's own venv, falling
# back to whatever is on PATH (CI installs the requirements with plain pip, no
# venv). Backs the lint:py, lint:py:fix and test targets of both Python apps,
# which used to be four near-identical copies of this file: they differ only in
# which directory they run in and which root script bootstraps their venv.
#
#   bash scripts/py-tool.sh <app-dir> <ruff|pytest> [args...]
#
# PY_SETUP names the bootstrap script quoted in the "not available" hint; it
# defaults to the bridge's, so only fleet-monitor has to set it.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: py-tool.sh <app-dir> <ruff|pytest> [args...]" >&2
  exit 2
fi

APP_DIR="$1"
TOOL="$2"
shift 2

cd "$(dirname "$0")/../$APP_DIR"
SETUP="${PY_SETUP:-setup:py}"

case "$TOOL" in
  ruff)
    RUFF="$PWD/.venv/bin/ruff"
    if [ ! -x "$RUFF" ]; then
      RUFF="$(command -v ruff)" || {
        echo "ruff not available - bootstrap the venv with: bun run $SETUP" >&2
        exit 1
      }
    fi
    exec "$RUFF" check "$@" .
    ;;
  pytest)
    PY="$PWD/.venv/bin/python"
    [ -x "$PY" ] || PY="$(command -v python3)"
    if ! "$PY" -m pytest --version >/dev/null 2>&1; then
      echo "pytest not available - bootstrap the venv with: bun run $SETUP" >&2
      exit 1
    fi
    exec "$PY" -m pytest -q "$@"
    ;;
  *)
    echo "py-tool.sh: unknown tool '$TOOL' (expected ruff or pytest)" >&2
    exit 2
    ;;
esac
