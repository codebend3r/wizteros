---
name: wizteros-verify
description: Use when running checks, tests, linting, formatting, or typechecking in the wizteros repo, when a pre-commit or pre-push hook fails, when CI fails, or before claiming work is complete. Covers which gate to run for which change, the Python venv bootstrap the bridge suite needs, and how to read each tool's output.
---

# Verifying wizteros

## Overview

Two languages, two test runners, a six-step lint and format gate, and a Python venv that must be bootstrapped before the bridge suite runs at all. Running the wrong gate wastes a minute; skipping the bootstrap produces an error that looks like a broken test suite but is not.

**Never claim work passes without running the gate and reading its output.**

## Which gate to run

| Change touches | Run |
|---|---|
| `web/` only | `bun run system-check` |
| `stripe-bridge/` only | `bun run lint:py` then `bun run test:bridge` |
| Both, or anything at the repo root | `bun run verify` |
| Before pushing, always | `bun run verify` |

```
system-check = lint + lint:css + lint:py + lint:dashes + format:check + typecheck + test:web
verify       = system-check + test:bridge
```

`.husky/pre-commit` runs `system-check`. `.husky/pre-push` runs `verify`. CI (`.github/workflows/ci.yml`) runs the web steps individually plus `ruff check` and `pytest`, on every branch push.

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
| ruff | `bun run lint:py` | Python in `stripe-bridge/` | `bun run lint:py:fix` |
| pytest | `bun run test:bridge` | bridge suite | none |
| check-dashes | `bun run lint:dashes` | en and em dashes in tracked files | none |

All three linters are configured: `web/.oxlintrc.json` (typescript, unicorn, oxc, react, jsx-a11y, import, and promise plugins, with `correctness` and `suspicious` as errors), `web/gale.json` (extends `gale:recommended`), and `stripe-bridge/ruff.toml` (F, E, W, I, UP, B, C4, SIM, DTZ, TID, PIE, RUF at line length 100, targeting py312). Formatting options live in `web/.oxfmtrc.json`; there is deliberately no Python formatter, see the note at the top of `ruff.toml`. Read the config before assuming a rule is or is not active.

**tsgo vs tsc.** `typecheck` uses `tsgo` (`@typescript/native-preview`), which is also what `build` runs. If tsgo reports something that looks wrong or unsupported, cross-check with `bun run typecheck:tsc` before assuming the code is at fault.

**Web tests.** `bun test` with `--dots`. The setup lives in `web/src/test-setup.ts` and `web/src/test/`, including a hand-rolled `vi.ts` shim and the happy-dom global registrator. A failure mentioning a missing DOM global usually means a test bypassed that setup, not that the component is broken.

**Bridge tests.** `pytest -q` from `stripe-bridge/`, using `responses` to stub Wizarr and plex.tv HTTP calls. A test hanging rather than failing usually means a request escaped the `responses` mock and is hitting a real 45-second-timeout endpoint.

## What the linters enforce, and what they do not

`web/.oxlintrc.json` already enforces a large slice of the CLAUDE.md house rules. Do not hand-review these; the linter fails the commit on them:

`interface` (`consistent-type-definitions` set to `type`), `any` (`no-explicit-any`), type assertions (`consistent-type-assertions` set to `never`, which still permits `as const`), non-null assertions, default exports (`import/no-default-export`), parent-relative `../` imports (`no-restricted-imports`), `var`, non-`const` bindings, loose equality, plus the react, jsx-a11y, import, and promise plugin rule sets. `ruff` covers the Python side, and `bun run lint:dashes` fails the commit on any en or em dash outside the allowlist in `scripts/check-dashes.sh`.

**Still convention only**, because no rule covers them:

- CSS: `display: grid` over flex, avoiding margins for spacing, using only tokens from `globals.scss`, no plain `div`s
- `for/of` and `for/in` (oxlint has no `no-restricted-syntax`, so this cannot be expressed today)
- `!!` for boolean conversion (`no-extra-boolean-cast` is deliberately off to permit it)
- `&&` over a ternary returning null, `?.` always paired with `??`, single object parameter
- Immutability, the 320px responsive requirement, and the a11y rules beyond what jsx-a11y catches

Passing `bun run verify` is necessary, not sufficient. Use the `wizteros-house-style-review` agent for the residual layer.

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
