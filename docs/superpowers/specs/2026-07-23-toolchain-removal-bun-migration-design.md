# Design: Remove ESLint/Prettier, go Bun-only, migrate tests to Bun test

**Status:** Approved (design), pending implementation plan
**Author:** CJ Rivas
**Date:** 2026-07-23
**Related:** `docs/prd/tooling-migration-prd.md`

---

## 1. Summary

Three coordinated changes to the wizteros toolchain:

- **A: Strip ESLint + Prettier** from the root package with **no replacement** linter/formatter.
- **B: Rework husky hooks:** pre-commit runs a placeholder `system-check` script; pre-push only echoes.
- **C: Make Bun the only supported package manager and runner** across the root and `web/` packages, with active enforcement that blocks npm/pnpm/yarn.
- **D: Migrate web unit tests from Vitest to Bun test**, spike-first, to improve unit-test speed.

This deliberately diverges from the PRD's "replace with the Oxc Rust toolchain" plan: the decision here is to **remove** ESLint/Prettier outright, not swap them for Oxlint/Oxfmt.

## 2. Explicit cost accepted

`eslint.config.mjs` currently machine-enforces several CLAUDE.md guardrails:

- `@typescript-eslint/no-explicit-any: error`
- `@typescript-eslint/consistent-type-definitions: ['error', 'type']` (type over interface)
- `@typescript-eslint/consistent-type-assertions: ['error', { assertionStyle: 'never' }]` (no casting)
- `no-restricted-syntax` banning `for/in` and `for/of`
- `no-restricted-imports` banning parent-relative imports in favor of the `@/` alias

After this change **none of these are enforced in CI or pre-commit.** They remain authoring guidance (CLAUDE.md) for humans and Claude, but nothing blocks a violation from landing. This trade-off is accepted.

## 3. Workstream A: Strip ESLint + Prettier (root `wizteros` package)

### Delete files
- `eslint.config.mjs`
- `.prettierrc`
- `.prettierignore`

### Root `package.json`
- **Remove devDeps:** `@eslint/js`, `eslint`, `eslint-config-prettier`, `globals`, `typescript-eslint`, `prettier`, `lint-staged`, and root `typescript` (only present to feed typescript-eslint; there is no root `tsconfig.json`, and `typecheck` delegates to web's own TypeScript).
- **Keep devDeps:** `husky`, `npm-run-all2`.
- **Remove scripts:** `lint`, `lint:fix`, `format`, `format:check`.
- **Remove the `lint-staged` config block** (pre-commit no longer calls lint-staged).
- **Rewrite `verify`:** `run-s typecheck test:web test:bridge` (drops `lint` + `format:check`). `verify` becomes manual-only (pre-push no longer calls it, see Workstream B). `npm-run-all2` stays because `verify` and `retest` still use `run-s`.

### CI (`.github/workflows/ci.yml`)
- Delete the `lint` job ("ESLint & Prettier") entirely, including its `npm ci` step.
- Leave `web` (bun) and `bridge` (python) jobs untouched.

## 4. Workstream B: Husky hooks

Husky is **kept** (auto-installs via the existing `prepare: husky` script on `bun install`).

- **`.husky/pre-commit`**: replace `npx lint-staged` with `bun run system-check`.
- **`.husky/pre-push`**: replace `npm run verify && npm run deploy:nas` with `echo "pushing now"`. Deploy is now manual (`bun run deploy:nas`).
- **New root script `system-check`**: placeholder no-op for now:
  `"system-check": "echo 'system-check: not yet defined' && exit 0"`.
  Real contents to be defined by the user later. It must exit 0 so pre-commit does not block.

## 5. Workstream C: Bun-only across root + web

### Migrate root package to bun
- Delete `package-lock.json`.
- Generate root `bun.lock` via `bun install`.
- `web/` already uses bun (`web/bun.lock`); unchanged.

### Remove `npm run` usages
- Root scripts already delegate to bun where relevant (`typecheck`, `test:web` use `bun run --cwd web ...`). No `npm run` remains after the `verify` rewrite.
- Node-runtime scripts (`test:e2e` via `node --env-file`, `e2e-retest.mjs`) are left on `node`: node is a runtime, not a package-manager runner, and is out of scope for the bun-only mandate.

### Enforcement: block npm/pnpm/yarn
Zero-dependency committed guard: **`scripts/only-bun.mjs`**.

- Reads `process.env.npm_config_user_agent`; if it does not start with `bun`, prints a clear error naming the offending tool and `process.exit(1)`; otherwise exits 0.
- Invoked as `node scripts/only-bun.mjs` (node is present in npm, pnpm, and bun script environments; `npm_config_user_agent` is set by whichever tool spawned the script).

Wiring:
- **Root `package.json`:** `"preinstall": "node scripts/only-bun.mjs"`: blocks `npm/pnpm/yarn install` at the root.
- **`web/package.json`:**
  - `"preinstall": "node ../scripts/only-bun.mjs"`: blocks non-bun install in web.
  - `"predev"`, `"prebuild"`, `"prepreview"`, `"pretest"`: `"node ../scripts/only-bun.mjs"`: blocks `npm run dev`, `pnpm run dev`, etc. npm, pnpm, and bun all auto-run `pre<script>`; bun passes the guard, the others abort before the real script runs.

Root run-scripts get **no** per-script guards (root has no `dev`; `preinstall` is sufficient there). Rationale: day-to-day `dev`/`build`/`test` live in `web/`, which is where the run-blocking guards matter.

### npm-run-all2
Kept/installed as a bun devDep. `run-s` inherits the invoking runner via `npm_execpath`, so under `bun run verify` it uses bun.

## 6. Workstream D: Vitest → Bun test (web), spike-first

### Current state
- 25 test files; 19 import from `vitest`.
- API usage: `vi.mocked` (91), `vi.fn` (55), `vi.stubGlobal` (12), `vi.restoreAllMocks` (7), `vi.mock` (6), `vi.spyOn` (3).
- Config lives in `web/vite.config.ts` `test:` block (jsdom, `globals: true`, `setupFiles: ./src/test-setup.ts`, env stubbing of `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY`).
- `web/src/test-setup.ts` imports `@testing-library/jest-dom`.
- `web/tsconfig.json`: `paths` `@/* -> ./src/*`; `"types": ["vitest/globals", "@testing-library/jest-dom"]`.

### Phase D1: Spike (one commit, gate the rest on it)
Stand up the Bun harness and migrate 2, 3 representative files:
- **`bunfig.toml`** with `[test] preload = ["./src/test-setup.ts"]`.
- Rework **`src/test-setup.ts`** to:
  - register a DOM via happy-dom `GlobalRegistrator` (Bun-native, faster than jsdom),
  - `import '@testing-library/jest-dom'`,
  - register `afterEach(cleanup)` from `@testing-library/react` (Bun does not auto-cleanup the way vitest-globals did).
- **`@/` alias:** Bun resolves it from `web/tsconfig.json` `paths` natively; no extra config.
- **`web/tsconfig.json`:** swap `"vitest/globals"` in `types` for Bun's test types.
- **Spike file selection:** include one file using `vi.mock`, one using `vi.stubGlobal`, and one plain `.ts` (e.g. `lib/*.test.ts`).

**Three go/no-go risks the spike must clear:**
1. **`import.meta.env.VITE_*`**: 9 vars used in non-test source. Vite injects these; Bun test does not run Vite's transform. Confirm how they resolve under Bun (env passthrough / shim) and replicate the vitest env stubbing (`VITE_SUPABASE_URL=''`, `VITE_SUPABASE_PUBLISHABLE_KEY=''`). **Primary go/no-go.**
2. **`vi.stubGlobal` (12)** and **`vi.mocked` (91, a TS-only helper)**: need Bun-compatible shims, likely a small local `test-utils` module (`stubGlobal` = set + restore; `mocked` = typed passthrough).
3. **`vi.mock` (6) hoisting/isolation**: `mock.module` does not hoist and can leak across files. Verify isolation on the spike file.

If any risk proves too costly mid-spike, **stop and surface it** (fallback: keep Vitest) rather than force the full sweep.

### Phase D2: Full sweep (only after D1 is green)
- Codemod remaining files: `from 'vitest'` → `bun:test` + the shims (`vi.fn`→`mock`/`jest.fn`, `vi.spyOn`→`spyOn`, `vi.restoreAllMocks`→`jest.restoreAllMocks`/`mock.restore`, `vi.mock`→`mock.module`).
- Remove the `test:` block from `web/vite.config.ts` (keep the build/plugin config).
- Update `web/package.json` `test` script → `bun test`.
- Remove `vitest` and `jsdom` devDeps; add `happy-dom` (and `@types/bun` or bun-types) as needed.
- Update the CI `web` job's `bun run test` if the script name/behavior changes (currently already `bun run test`).

## 7. Sequencing & commits

Each is an independent, revertible commit (per CLAUDE.md, **do not commit until the user says so**):

1. Workstream A: strip ESLint/Prettier (files, package.json, CI).
2. Workstream B + C: husky rework, `system-check` placeholder, `only-bun.mjs` guard, root bun migration, enforcement wiring.
3. Workstream D1: Bun test spike (harness + representative files). **Gate.**
4. Workstream D2: full test sweep + remove Vitest/jsdom.

## 8. Rollback

- A: restore deleted config files + devDeps from git history.
- B/C: revert hook + package.json changes; `only-bun.mjs` is additive and self-contained.
- D: spike is isolated; full sweep is revertible per-file since config change is the switch.

## 9. Open items for implementation

- Exact Bun test types package for `tsconfig.json` (`@types/bun` vs bun-types), confirm during D1.
- Whether happy-dom fully covers the current jsdom-dependent component tests, confirm during D1.
- `system-check` real contents, deferred to the user.
