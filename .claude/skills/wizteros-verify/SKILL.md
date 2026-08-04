---
name: wizteros-verify
description: Use when running checks, tests, linting, formatting, or typechecking in the wizteros repo, when a pre-commit or pre-push hook fails, when CI fails, or before claiming work is complete. Covers which gate to run for which change, the Python venv bootstrap the bridge suite needs, and how to read each tool's output.
---

# Verifying wizteros

## Overview

Two languages, two test runners, four linters, and a Python venv that must be bootstrapped before the bridge suite runs at all. Running the wrong gate wastes a minute; skipping the bootstrap produces an error that looks like a broken test suite but is not.

**Never claim work passes without running the gate and reading its output.**

## Which gate to run

| Change touches | Run |
|---|---|
| `web/` only | `bun run system-check` |
| `stripe-bridge/` only | `bun run test:bridge` |
| Both, or anything at the repo root | `bun run verify` |
| Before pushing, always | `bun run verify` |

```
system-check = lint + lint:css + format:check + typecheck + test:web
verify       = system-check + test:bridge
```

`.husky/pre-commit` runs `system-check`. `.husky/pre-push` runs `verify`. CI (`.github/workflows/ci.yml`) runs the web steps individually plus `pytest`, on every branch push.

## First run in a fresh clone

```bash
bun install        # root tooling plus husky hooks
bun run setup:py   # creates ./venv from stripe-bridge/requirements-dev.txt
```

Without `setup:py`, `scripts/test-bridge.sh` falls back to system `python3` and exits with `pytest not available, bootstrap the venv with: npm run setup:py`. That is a missing venv, not a failing test.

The repo is bun-only. `scripts/only-bun.mjs` runs as a `preinstall`, `predev`, `prebuild`, and `pretest` guard and hard-fails under npm, yarn, or pnpm. Use `bun`.

## The tools and what their failures mean

| Tool | Command | Covers | Auto-fix |
|---|---|---|---|
| oxlint | `bun run lint` | TS/JS correctness | `bun run lint:fix` |
| gale | `bun run lint:css` | SCSS in `web/src/**/*.scss` | `bun run lint:css:fix` |
| oxfmt | `bun run format:check` | formatting across `web/` | `bun run format` |
| tsgo | `bun run typecheck` | types (native preview compiler) | none |
| bun test | `bun run test` | web suite, happy-dom | none |
| pytest | `bun run test:bridge` | bridge suite | none |

Neither linter is configured with a rc file, so both run on defaults.

**tsgo vs tsc.** `typecheck` uses `tsgo` (`@typescript/native-preview`), which is also what `build` runs. If tsgo reports something that looks wrong or unsupported, cross-check with `bun run typecheck:tsc` before assuming the code is at fault.

**Web tests.** `bun test` with `--dots`. The setup lives in `web/src/test-setup.ts` and `web/src/test/`, including a hand-rolled `vi.ts` shim and the happy-dom global registrator. A failure mentioning a missing DOM global usually means a test bypassed that setup, not that the component is broken.

**Bridge tests.** `pytest -q` from `stripe-bridge/`, using `responses` to stub Wizarr and plex.tv HTTP calls. A test hanging rather than failing usually means a request escaped the `responses` mock and is hitting a real 45-second-timeout endpoint.

## What the linters do not catch

The repo's CLAUDE.md house rules are convention, not tooling. oxlint will not flag `interface`, `any`, `as` casts, default exports, `../` imports, `display: flex`, hardcoded hex values, or en and em dashes. Passing `bun run verify` is necessary, not sufficient. Use the `wizteros-house-style-review` agent for that layer.

## Red Flags

- Claiming "tests pass" without having run the command in this session
- Reporting success when the bridge suite was skipped for a missing venv
- Running only `test:web` after editing `stripe-bridge/`
- Treating a `pytest not available` message as a test failure
- Using `npm` or `yarn` and hitting the only-bun guard, then working around it

## Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `pytest not available` | No venv | `bun run setup:py` |
| Install aborts immediately | npm/yarn/pnpm used | Use `bun` |
| Pre-push fails, pre-commit passed | `verify` adds the bridge suite | Run `bun run verify` locally |
| Format check fails on untouched files | oxfmt scans all of `web/` | `bun run format` |
| Bridge test hangs | Unmocked HTTP request | Add the `responses` stub |
