# Toolchain Removal + Bun Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ESLint/Prettier from the repo, make Bun the only supported package manager/runner, and migrate web unit tests from Vitest to Bun test.

**Architecture:** Three independent workstreams landed as ordered commits. First strip the lint/format toolchain (pure deletion). Then rework husky hooks and enforce bun-only with a zero-dependency guard script plus a root bun migration. Finally migrate tests to Bun test, spike-first: prove the harness on two representative files before sweeping the remaining 23.

**Tech Stack:** Bun (pm + runner + test runner), happy-dom, @testing-library/react + jest-dom, husky, npm-run-all2. React 18 + Vite + TypeScript app in `web/`.

## Global Constraints

- **Commit/push gate (CLAUDE.md):** Do NOT run `git commit` or `git push` without explicit user approval. Each task ends at a commit boundary, when you reach it, stage the changes, show the diff summary, and request approval before committing. The commit commands below are the intended boundaries, not license to auto-commit.
- **Commit subject:** must start with `WZ:` followed by a short title. Favor bullet points in the body.
- **No agent attribution** in any commit or PR (no Claude/Claude Code mentions, no co-author trailers).
- **Package manager:** Bun only. Never run `npm`/`pnpm`/`yarn`. Use `bun install`, `bun add --exact`, `bun run <script>`, `bun test`.
- **Exact-pin deps** in `web/`: use `bun add --exact` (web deps are exact-pinned via tracked `bun.lock`).
- **TypeScript rules (still authoring guidance after ESLint removal):** no `any`, no type casting (`as`), prefer type guards, `type` aliases not `interface`, no `for/in`/`for/of` (use array methods), import via `@/` alias not parent-relative paths.

---

## File Structure

**Workstream A (delete):** `eslint.config.mjs`, `.prettierrc`, `.prettierignore`.
**Workstream A (modify):** root `package.json`, `.github/workflows/ci.yml`.
**Workstream B/C (create):** `scripts/only-bun.mjs`, root `bun.lock` (generated).
**Workstream B/C (delete):** `package-lock.json`.
**Workstream B/C (modify):** root `package.json`, `web/package.json`, `.husky/pre-commit`, `.husky/pre-push`.
**Workstream D (create):** `web/bunfig.toml`, `web/src/test/vi.ts` (compat shim).
**Workstream D (modify):** `web/src/test-setup.ts`, `web/tsconfig.json`, `web/vite.config.ts`, `web/package.json`, all 25 `web/src/**/*.test.*` files.
**Workstream D (delete):** Vitest config block + `vitest`/`jsdom` devDeps.

---

## Task 1: Strip ESLint + Prettier from the root package

**Files:**
- Delete: `eslint.config.mjs`, `.prettierrc`, `.prettierignore`
- Modify: `package.json` (root), `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a root `package.json` with no lint/format scripts or deps; a CI workflow with only `web` + `bridge` jobs. Task 2 further edits root `package.json`.

- [ ] **Step 1: Delete the config files**

```bash
git rm eslint.config.mjs .prettierrc .prettierignore
```

- [ ] **Step 2: Edit root `package.json` scripts**

Remove these four script lines entirely: `"lint"`, `"lint:fix"`, `"format"`, `"format:check"`.
Rewrite `verify` to drop the removed gates:

```json
    "verify": "run-s typecheck test:web test:bridge",
```

- [ ] **Step 3: Remove the `lint-staged` config block from root `package.json`**

Delete the whole block (the pre-commit hook stops using it in Task 2):

```json
  "lint-staged": {
    "*.{js,mjs,cjs,ts,tsx}": [
      "eslint --fix --no-warn-ignored",
      "prettier --write"
    ],
    "*.{json,scss,css,md,yml,yaml,html}": "prettier --write"
  },
```

- [ ] **Step 4: Remove lint/format devDeps from root `package.json`**

Delete these keys from `devDependencies`: `@eslint/js`, `eslint`, `eslint-config-prettier`, `globals`, `typescript-eslint`, `prettier`, `lint-staged`, and `typescript` (root TS existed only to feed typescript-eslint; there is no root `tsconfig.json`, and `typecheck` runs in web). Keep `husky` and `npm-run-all2`.

Resulting `devDependencies`:

```json
  "devDependencies": {
    "husky": "^9.1.7",
    "npm-run-all2": "^9.0.2"
  }
```

- [ ] **Step 5: Delete the CI `lint` job**

In `.github/workflows/ci.yml`, remove the entire `lint:` job (the block starting `  lint:` with name "ESLint & Prettier", through its last `- run: npm run format:check` step). Leave `web` and `bridge` jobs unchanged.

- [ ] **Step 6: Verify no ESLint/Prettier references remain in tooling**

Run: `git grep -iE 'eslint|prettier|lint-staged' -- ':!docs/' ':!web/docs/'`
Expected: no matches (docs/PRD references are excluded and may remain).

- [ ] **Step 7: Verify the workflow still parses and root scripts are intact**

Run: `bun run --silent 2>/dev/null; node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"`
Expected: `package.json OK` (no JSON syntax error from the edits).

- [ ] **Step 8: Stage and request approval, then commit**

```bash
git add -A
git commit -m "WZ: Remove ESLint and Prettier from the toolchain

- Delete eslint.config.mjs, .prettierrc, .prettierignore
- Drop lint/format scripts, lint-staged block, and their devDeps
- Rewrite verify to run typecheck + tests only
- Remove the ESLint & Prettier CI job"
```

---

## Task 2: Bun-only enforcement, husky rework, root bun migration

**Files:**
- Create: `scripts/only-bun.mjs`, `bun.lock` (generated by `bun install`)
- Delete: `package-lock.json`
- Modify: `package.json` (root), `web/package.json`, `.husky/pre-commit`, `.husky/pre-push`

**Interfaces:**
- Consumes: root `package.json` from Task 1.
- Produces: `scripts/only-bun.mjs` exporting nothing (a CLI guard invoked as `node scripts/only-bun.mjs`); it exits non-zero unless `npm_config_user_agent` starts with `bun`. Referenced by `preinstall` (root + web) and `predev`/`prebuild`/`prepreview`/`pretest` (web).

- [ ] **Step 1: Write a failing check for the guard script**

Confirm the guard does not exist yet.
Run: `test -f scripts/only-bun.mjs && echo EXISTS || echo MISSING`
Expected: `MISSING`

- [ ] **Step 2: Create `scripts/only-bun.mjs`**

```js
// Aborts any package-manager script run by a tool other than Bun.
// Wired as preinstall (root + web) and pre<script> guards in web so that
// `npm run dev`, `pnpm run dev`, `npm install`, etc. fail fast while bun passes.
const agent = process.env.npm_config_user_agent ?? ''
const runner = agent.split('/')[0] || 'unknown'

if (!agent.startsWith('bun')) {
  console.error(
    `\n[31mThis repo is Bun-only.[0m Detected "${runner}".\n` +
      `Use bun instead:\n` +
      `  bun install            (not npm/pnpm/yarn install)\n` +
      `  bun run <script>       (not npm run <script>)\n`,
  )
  process.exit(1)
}
```

- [ ] **Step 3: Verify the guard blocks npm and allows bun**

Run: `npm_config_user_agent="npm/10.0.0 node/v22" node scripts/only-bun.mjs; echo "exit=$?"`
Expected: prints the Bun-only error and `exit=1`.

Run: `npm_config_user_agent="bun/1.1.0" node scripts/only-bun.mjs; echo "exit=$?"`
Expected: no error output and `exit=0`.

- [ ] **Step 4: Add `preinstall` + `system-check` to root `package.json` scripts**

Add these two scripts (place `preinstall` first, `system-check` alongside the others):

```json
    "preinstall": "node scripts/only-bun.mjs",
    "system-check": "echo 'system-check: not yet defined' && exit 0",
```

- [ ] **Step 5: Add guards to `web/package.json` scripts**

Add a `preinstall` plus `pre<script>` guards. The web guard references the root script via `../`:

```json
    "preinstall": "node ../scripts/only-bun.mjs",
    "predev": "node ../scripts/only-bun.mjs",
    "prebuild": "node ../scripts/only-bun.mjs",
    "prepreview": "node ../scripts/only-bun.mjs",
    "pretest": "node ../scripts/only-bun.mjs",
```

- [ ] **Step 6: Rework the husky hooks**

Overwrite `.husky/pre-commit` with exactly:

```sh
bun run system-check
```

Overwrite `.husky/pre-push` with exactly:

```sh
echo "pushing now"
```

- [ ] **Step 7: Migrate the root lockfile to bun**

```bash
git rm package-lock.json
bun install
```
Expected: `bun install` completes and creates/updates `bun.lock` at the repo root (the `preinstall` guard passes because bun set `npm_config_user_agent`).

- [ ] **Step 8: Verify enforcement end-to-end**

Run: `cd web && npm run dev; echo "exit=$?"; cd ..`
Expected: the Bun-only error and `exit=1` (npm never reaches Vite).

Run (should pass the guard: Ctrl-C after Vite starts): `cd web && bun run predev; echo "exit=$?"; cd ..`
Expected: `exit=0`, no error.

- [ ] **Step 9: Verify husky hooks fire**

Run: `bun run system-check`
Expected: prints `system-check: not yet defined` and exits 0.

- [ ] **Step 10: Stage, request approval, then commit**

```bash
git add -A
git commit -m "WZ: Enforce Bun as the only package manager and runner

- Add scripts/only-bun.mjs guard; wire preinstall + pre<script> hooks
- pre-commit runs system-check placeholder; pre-push only echoes
- Migrate root lockfile from npm to bun.lock"
```

---

## Task 3: Bun test spike (harness + 2 representative files), GATE

> This is a spike: build the Bun test harness and prove it on `adminApi.test.ts` (hits `import.meta.env`, `vi.stubGlobal`, `vi.mock`, `vi.fn`, `vi.restoreAllMocks`) and `ResetUser.test.tsx` (hits component render + `vi.mocked` + `vi.mock` with `importOriginal`). Do NOT proceed to Task 4 until all three risks below are cleared. If a risk cannot be cleared cheaply, STOP and report; the fallback is keeping Vitest.

**Files:**
- Create: `web/bunfig.toml`, `web/src/test/vi.ts`
- Modify: `web/src/test-setup.ts`, `web/tsconfig.json`, `web/package.json`, `web/src/lib/adminApi.test.ts`, `web/src/pages/ResetUser/ResetUser.test.tsx`

**Interfaces:**
- Produces: `web/src/test/vi.ts`: a compat module re-exporting `test, expect, describe, it, beforeEach, afterEach` from `bun:test` plus a `vi` object with `fn`, `spyOn`, `mock`, `mocked`, `stubGlobal`, `restoreAllMocks`. Task 4 migrates the remaining files by repointing their `from 'vitest'` import to `@/test/vi`.

- [ ] **Step 1: Install the DOM + Bun test type deps in web**

```bash
cd web && bun add --exact --dev happy-dom @types/bun && cd ..
```
Expected: `happy-dom` and `@types/bun` added to `web/package.json` devDependencies, `bun.lock` updated.

- [ ] **Step 2: Create `web/bunfig.toml`**

```toml
[test]
preload = ["./src/test-setup.ts"]
```

- [ ] **Step 3: Rework `web/src/test-setup.ts`**

```ts
import { afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

// Bun test has no DOM by default and does not auto-cleanup RTL the way
// vitest globals did; register happy-dom once and unmount after each test.
GlobalRegistrator.register()

afterEach(() => {
  cleanup()
})
```

Note: `@happy-dom/global-registrator` ships with `happy-dom`. If the import path resolves differently for the installed version, confirm with `ls web/node_modules/@happy-dom`.

- [ ] **Step 4: Create the `web/src/test/vi.ts` compat shim**

```ts
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
  test,
  type Mock,
} from 'bun:test'

export { afterEach, beforeEach, describe, expect, it, test }

// Records globals replaced via stubGlobal so they can be restored.
const stubbedGlobals = new Map<string, { existed: boolean; value: unknown }>()

const stubGlobal = (name: string, value: unknown): void => {
  if (!stubbedGlobals.has(name)) {
    stubbedGlobals.set(name, {
      existed: Reflect.has(globalThis, name),
      value: Reflect.get(globalThis, name),
    })
  }
  Reflect.set(globalThis, name, value)
}

const restoreGlobals = (): void => {
  stubbedGlobals.forEach(({ existed, value }, name) => {
    existed ? Reflect.set(globalThis, name, value) : Reflect.deleteProperty(globalThis, name)
  })
  stubbedGlobals.clear()
}

// vitest's vi.mocked is a typing bridge: the value is already a bun mock at
// runtime (via mock.module); narrow to the mock type with a type guard.
const isMock = <F extends (...args: never[]) => unknown>(fn: F): fn is F & Mock<F> => 'mock' in fn

const mocked = <F extends (...args: never[]) => unknown>(fn: F): F & Mock<F> => {
  if (!isMock(fn)) throw new Error('vi.mocked(): value is not a bun mock')
  return fn
}

export const vi = {
  fn: mock,
  spyOn,
  mock: mock.module,
  mocked,
  stubGlobal,
  restoreAllMocks: () => {
    jest.restoreAllMocks()
    restoreGlobals()
  },
}

// Restore stubbed globals after every test even if a suite forgets to.
afterEach(restoreGlobals)
```

- [ ] **Step 5: Point `web/tsconfig.json` at Bun's test types**

Replace the `types` line:

```json
    "types": ["@types/bun", "@testing-library/jest-dom"]
```

- [ ] **Step 6: Migrate `adminApi.test.ts` and `ResetUser.test.tsx` imports**

In both files, change the test-framework import source from `'vitest'` to `'@/test/vi'`, keeping the same named imports. Example for `adminApi.test.ts`:

```ts
import { afterEach, expect, test, vi } from '@/test/vi'
```

For `ResetUser.test.tsx`, likewise repoint whatever it imports (`describe`, `test`/`it`, `expect`, `vi`, `beforeEach`, etc.) from `'vitest'` to `'@/test/vi'`. Do not change any `vi.*` call sites; the shim mirrors the API.

- [ ] **Step 7: Run the two spike files under Bun test**

Run: `cd web && bun test src/lib/adminApi.test.ts src/pages/ResetUser/ResetUser.test.tsx`
Expected: all tests pass.

- [ ] **Step 8: Clear the three go/no-go risks (decision point)**

Verify explicitly and record the outcome:
1. **`import.meta.env.VITE_*`**: `adminApi.ts` reads `import.meta.env.VITE_ADMIN_API_BASE`. Confirm the test passes without a `ReferenceError`/`undefined` crash. If Bun does not populate `import.meta.env`, add the env shim: create `web/src/test/env.ts` setting the needed `import.meta.env` values and preload it via `bunfig.toml` (append to the `preload` array), replicating the old vitest `env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' }` stubbing.
2. **`vi.stubGlobal('fetch', ...)`**: confirm the `fetchMembers` test asserts on the bearer token, i.e. the stubbed `fetch` is actually called and restored between tests (no leakage into the next test).
3. **`vi.mock` isolation/hoisting**: confirm the `@/lib/supabaseClient` and `@/lib/adminApi` mocks take effect. If `mock.module` does not intercept because the real module was imported first, restructure: move the `mock.module` calls into a preload file, or convert the file's top-level imports of the mocked module to `await import(...)` inside the tests. Record which approach was needed.

If all three pass with the shim as written, continue. If any needs a workaround, apply the minimal one above and re-run Step 7. If a risk is unresolvable cheaply, STOP and report for a keep-Vitest decision.

- [ ] **Step 9: Confirm typecheck still passes**

Run: `cd web && bun run typecheck`
Expected: no errors (validates the `vi.ts` shim types and the `tsconfig` types change).

- [ ] **Step 10: Stage, request approval, then commit**

```bash
git add -A
git commit -m "WZ: Stand up Bun test harness (spike)

- Add bunfig.toml preload, happy-dom DOM registration, RTL cleanup
- Add src/test/vi.ts vitest-compat shim (fn/mock/mocked/stubGlobal)
- Migrate adminApi and ResetUser tests as the spike proof
- Point tsconfig types at @types/bun"
```

---

## Task 4: Full test sweep + remove Vitest, GATED on Task 3

**Files:**
- Modify: the remaining 23 `web/src/**/*.test.*` files, `web/vite.config.ts`, `web/package.json`
- Delete: `vitest` + `jsdom` devDeps

**Interfaces:**
- Consumes: `@/test/vi` shim and harness from Task 3.

- [ ] **Step 1: List the files still importing from vitest**

Run: `cd web && git grep -l "from 'vitest'" -- 'src/**/*.test.*'`
Expected: the 17 remaining test files (adminApi + ResetUser already migrated).

- [ ] **Step 2: Codemod the import source in every remaining test file**

For each file, replace the framework import source `'vitest'` with `'@/test/vi'`, preserving the named imports. Do not touch `vi.*` call sites. One-shot codemod:

```bash
cd web && git grep -l "from 'vitest'" -- 'src/**/*.test.*' | xargs sed -i '' "s#from 'vitest'#from '@/test/vi'#g" && cd ..
```

- [ ] **Step 3: Verify no test file imports vitest anymore**

Run: `cd web && git grep -l "vitest" -- 'src/**/*.test.*'; echo "exit=$?"`
Expected: no matches, `exit=1`.

- [ ] **Step 4: Remove the Vitest config block from `web/vite.config.ts`**

Change the import back to Vite's own `defineConfig`, and delete the `test: { ... }` block entirely (keep `plugins`, `resolve.alias`, `css`):

```ts
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
})
```

- [ ] **Step 5: Point the web `test` script at Bun test**

In `web/package.json`, change the `test` script:

```json
    "test": "bun test",
```

- [ ] **Step 6: Remove Vitest + jsdom devDeps**

```bash
cd web && bun remove vitest jsdom && cd ..
```
Expected: `vitest` and `jsdom` removed from `web/package.json` and `bun.lock`.

- [ ] **Step 7: Run the full suite under Bun test**

Run: `cd web && bun test`
Expected: all 25 test files pass. If any file fails on a mock-isolation issue surfaced only at scale (cross-file `mock.module` leakage), apply the Task 3 Step 8.3 workaround to that file and re-run.

- [ ] **Step 8: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: no errors (`vite.config.ts` no longer references vitest; `tsconfig` no longer needs `vitest/globals`).

- [ ] **Step 9: Confirm the CI web job still works as written**

The CI `web` job runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`. `bun run test` now invokes `bun test`. No workflow edit needed, verify by re-reading `.github/workflows/ci.yml` and confirming the `web` job commands are unchanged and valid.

- [ ] **Step 10: Stage, request approval, then commit**

```bash
git add -A
git commit -m "WZ: Migrate web unit tests from Vitest to Bun test

- Repoint all test files at the @/test/vi compat shim
- Drop the vitest config block from vite.config.ts
- Switch the test script to bun test; remove vitest + jsdom"
```

---

## Self-Review

**Spec coverage:**
- §3 Workstream A → Task 1. ✓ (files deleted, deps/scripts removed, CI job removed)
- §4 Workstream B (husky) → Task 2 Steps 4, 6, 9. ✓ (`system-check` placeholder, pre-commit, pre-push)
- §5 Workstream C (bun-only) → Task 2 Steps 2, 8. ✓ (guard, preinstall, pre<script>, root bun.lock, npm-run-all2 kept)
- §6 Workstream D1 (spike) → Task 3, with all three risks as explicit gate Step 8. ✓
- §6 Workstream D2 (full sweep) → Task 4. ✓ (codemod, config removal, dep removal)
- §7 Sequencing (A; B+C; D1 gate; D2) → Tasks 1/2/3/4 order. ✓

**Placeholder scan:** `system-check` body is an intentional no-op placeholder per the spec (user defines later), not a plan gap. Task 3 is explicitly a spike with a decision point; its workarounds (env shim, mock restructuring) are conditional and fully specified where they apply. No "TBD"/"handle edge cases" left.

**Type consistency:** the shim exports `vi` with `{ fn, spyOn, mock, mocked, stubGlobal, restoreAllMocks }`: every `vi.*` used in the codebase (`vi.fn`, `vi.spyOn`, `vi.mock`, `vi.mocked`, `vi.stubGlobal`, `vi.restoreAllMocks`) is covered. `@/test/vi` import path is consistent across Tasks 3 and 4. Guard script name `scripts/only-bun.mjs` and its `../scripts/only-bun.mjs` web reference are consistent.

**Open risk carried into execution:** Task 3 Step 8 may require the env shim and/or mock restructuring; both are specified inline. If `mock.module` leakage appears only at full-suite scale, Task 4 Step 7 points back to the same fix.
