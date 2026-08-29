#!/usr/bin/env bash
# Run `ruff check --fix` over the staged Python files lint-staged hands in.
# lint-staged runs a task in the directory of the closest config, so the cwd is
# always the app root and the app's own venv is the first place to look. Falls
# back to whatever ruff is on PATH, matching apps/*/scripts/lint-*.sh.
set -euo pipefail

RUFF="$PWD/.venv/bin/ruff"
if [ ! -x "$RUFF" ]; then
  RUFF="$(command -v ruff)" || {
    echo "ruff not available - bootstrap the venv with: bun run setup:py" >&2
    exit 1
  }
fi

exec "$RUFF" check --fix "$@"
