# PRD: Migrate Frontend Tooling to Rust/Go-Based Toolchain

**Status:** Draft
**Author:** CJ Rivas
**Last updated:** 2026-07-23

---

## 1. Summary

Replace ESLint, Prettier, and Vitest with a Rust/Go-based toolchain: Oxlint (linting + type-aware rules), Oxfmt (formatting, including SCSS), tsgo (type checking), Gale (SCSS/CSS lint rules), and Bun test (unit testing). The goal is a dramatically faster local feedback loop and CI pipeline with no loss of code-quality coverage.

## 2. Background and Problem Statement

The current toolchain (ESLint + Prettier + Vitest + tsc) is Node/JS-based and is the slowest part of both the local developer loop and CI:

- Lint runs take minutes on large diffs; pre-commit hooks are slow enough that developers skip them.
- Prettier formatting on save has noticeable latency in large files.
- `tsc --noEmit` is a CI bottleneck.
- ESLint config maintenance (plugin version matrix, flat config migration debt) is a recurring cost.

A new generation of tooling written in Rust and Go (Oxc project, TypeScript 7 / tsgo, Bun) offers 10x to 30x speedups with drop-in or near-drop-in compatibility.

## 3. Goals

1. Reduce full-repo lint time by at least 10x.
2. Reduce full-repo format check time by at least 10x.
3. Reduce type-check time by at least 5x using tsgo.
4. Consolidate formatting for JS/TS/JSON/YAML/Markdown/CSS/SCSS under one tool (Oxfmt).
5. Keep SCSS lint coverage at parity with the current Stylelint ruleset via Gale.
6. Zero net-new lint noise: the migrated ruleset must not introduce a wave of new violations on day one (use suppressions or rule downgrades where needed).
7. CI pipeline for lint + format + typecheck completes in under 60 seconds on a warm cache.

## 4. Non-Goals

- Migrating the bundler (webpack/Vite/Next.js build) is out of scope for this PRD.
- Migrating E2E tests (Playwright/Cypress) is out of scope.
- Adopting Bun as the runtime or package manager for the app itself is out of scope; Bun is used only as a test runner.
- Rewriting custom ESLint rules that have no Oxlint equivalent (these are handled via the exception process in Section 9).

## 5. Proposed Toolchain

| Concern | Current | Target | Notes |
|---|---|---|---|
| JS/TS linting | ESLint + plugins | Oxlint | Rust. Supports most eslint, typescript-eslint, react, jsx-a11y, import, unicorn rules natively. |
| Type-aware linting | typescript-eslint | oxlint-tsgolint (`oxlint --type-aware`) | Backed by tsgo. |
| Type checking | tsc | tsgo (`@typescript/native-preview`) | Go port of the TypeScript compiler. Can also run via `oxlint --type-aware --type-check`. |
| Formatting (all langs) | Prettier | Oxfmt | Rust. Passes 100% of Prettier JS/TS conformance tests. Formats JS/TS/JSX/TSX, JSON, YAML, TOML, HTML, Vue, CSS, SCSS, Less, Markdown, MDX, GraphQL. Tailwind class sorting built in. |
| SCSS/CSS linting | Stylelint | Gale | Rust. Drop-in Stylelint replacement: reads existing `.stylelintrc`, honors `stylelint-disable` comments, 260+ rules, LSP server. `.sass` (indented) not supported. |
| Unit testing | Vitest | Bun test | Zig. Jest-compatible API. See risks in Section 10. |
| Editor integration | ESLint + Prettier extensions | Oxc VS Code extension, Gale LSP | Format-on-save and inline diagnostics. |

### 5.1 Framework Coverage: React and Next.js

This migration assumes a React/Next.js codebase and the toolchain covers it as follows:

- **Oxlint plugins:** enable the built-in `react`, `jsx-a11y`, and `nextjs` plugins in `.oxlintrc.json`. Together these cover react, react-hooks, jsx-a11y, and the `eslint-config-next` / `next/core-web-vitals` rule sets. The Phase 2 rule-mapping doc must diff the effective `eslint-config-next` rules against Oxlint's nextjs plugin and record any gaps.
- **`next lint` decoupling:** newer Next.js versions have removed `next lint` in favor of running a linter directly. Lint scripts must invoke `oxlint` directly, not the Next CLI.
- **JSX/TSX:** fully supported by Oxlint, Oxfmt, and tsgo. No template-linting gap applies (that limitation affects Vue/Svelte/Angular, not React).
- **Tailwind:** if present, Oxfmt's automatic class sorting replaces `prettier-plugin-tailwindcss`.
- **tsconfig:** tsgo must include `next-env.d.ts` and the Next.js TypeScript plugin settings; verify parity during the Phase 3 parallel run.
- **Testing (see FR-5 and Section 10):** React component tests require a DOM preload (happy-dom), `@testing-library/jest-dom` matcher registration, and explicit RTL cleanup in Bun test setup. Next.js module mocks (`next/navigation`, `next/router`, `next/image`, `next/link`, server actions) must be inventoried in Phase 0; Bun's `mock.module` differs from `vi.mock` (no hoisting, potential cross-file mock leakage) and is the primary go/no-go input for Open Question 1. Async React Server Components are not unit-testable in any runner and remain in E2E coverage (out of scope).
- **Build:** Next.js already compiles with SWC/Turbopack internally; nothing in this migration touches the build pipeline.

## 6. Users and Impact

- **Frontend engineers (primary):** faster save/lint/test loops, single formatter config, fewer devDependencies.
- **CI/CD:** shorter pipelines, lower runner costs.
- **New hires:** simpler onboarding; fewer tools and configs to learn.

## 7. Requirements

### 7.1 Functional

**FR-1: Linting**
- Oxlint replaces ESLint as the required lint gate in CI and pre-commit.
- Type-aware rules enabled via `oxlint --type-aware` with `oxlint-tsgolint` installed.
- Rule mapping documented: every currently enforced ESLint rule maps to an Oxlint rule, a Gale rule, or a documented exception.
- `oxlint --fix` supported in the pre-commit hook.

**FR-2: Formatting**
- Oxfmt replaces Prettier for all supported file types, including `.scss`.
- `.oxfmtrc.json` reproduces current Prettier settings (print width, quotes, trailing commas, etc.).
- A one-time full-repo reformat commit is created and added to `.git-blame-ignore-revs`.
- Format check (`oxfmt --check`) is a required CI gate.

**FR-3: Type checking**
- tsgo replaces tsc for `typecheck` scripts and CI.
- tsc is retained in the repo for a two-sprint parallel-run period; any output discrepancies are filed as blockers.
- The tsgo version is kept in sync with the tsgolint shim version used by Oxlint.

**FR-4: SCSS linting**
- Gale runs against all `.scss` files using the existing `.stylelintrc` (unchanged where possible).
- Any Stylelint plugin rules not covered by Gale are listed with a decision: drop, replace, or keep Stylelint for that subset temporarily.

**FR-5: Testing**
- Bun test replaces Vitest for unit and component tests.
- All existing tests pass under Bun test, or are ticketed with an owner before cutover.
- DOM environment (happy-dom or jsdom preload) configured for React component tests.
- Coverage reporting produces output consumable by the existing coverage gate.
- Watch mode and single-file runs work locally.

**FR-6: Developer experience**
- `package.json` scripts updated: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `test`, `test:watch`.
- Pre-commit hooks (husky/lefthook/lint-staged or equivalent) updated to use the new tools.
- Recommended VS Code extensions and settings committed to `.vscode/`.
- Migration guide added to the repo README or CONTRIBUTING.

### 7.2 Non-Functional

- NFR-1: Full-repo lint under 5 seconds on a typical developer machine.
- NFR-2: Full-repo format check under 5 seconds.
- NFR-3: Full-repo typecheck under 20% of current tsc wall time.
- NFR-4: Unit test suite wall time reduced by at least 30% versus Vitest.
- NFR-5: No regression in CI flake rate attributable to the new test runner over a 2-week observation window.

## 8. Migration Plan

### Phase 0: Baseline and audit (0.5 sprint)
- Record current timings: ESLint full run, Prettier check, tsc, Vitest suite (local and CI).
- Export the effective ESLint rule set (`eslint --print-config`) for the rule-mapping exercise.
- Inventory Stylelint plugins and custom ESLint rules in use.
- Inventory Vitest-specific APIs in the test suite (`vi.mock`, `vi.useFakeTimers`, inline snapshots, `test.each`, workspace config, setup files).
- Inventory all mocks of Next.js modules (`next/navigation`, `next/router`, `next/image`, `next/link`, server actions) and count affected test files; this feeds the Bun test go/no-go decision (Open Question 1).

### Phase 1: Formatting (0.5 sprint, lowest risk)
- Add Oxfmt, port Prettier config to `.oxfmtrc.json`.
- Run `npx oxfmt .` in a single reformat commit; add to `.git-blame-ignore-revs`.
- Swap CI gate from `prettier --check` to `oxfmt --check`.
- Remove Prettier and its plugins.
- Exit criteria: CI green, no formatting churn in subsequent PRs.

### Phase 2: Linting (1 sprint)
- Add Oxlint; run the oxc migration tooling against the existing ESLint config.
- Complete the rule-mapping doc; enable type-aware rules with oxlint-tsgolint.
- Run ESLint and Oxlint in parallel in CI for one week (Oxlint blocking, ESLint informational).
- Add Gale for SCSS using the existing `.stylelintrc`; verify rule parity on a sample of known violations.
- Remove ESLint, its plugins, and Stylelint (or scope Stylelint down per FR-4).
- Exit criteria: rule-mapping doc approved, one week of parallel runs with no missed high-severity issues.

### Phase 3: Type checking (0.5 sprint)
- Add `@typescript/native-preview`; add `typecheck:tsgo` script.
- Parallel-run tsgo and tsc in CI for two sprints; diff outputs.
- Flip the blocking gate to tsgo; keep tsc as a manual escape hatch until Phase 5.
- Exit criteria: zero unexplained diagnostic differences on main for two sprints.

### Phase 4: Testing (1 to 2 sprints, highest risk)
- Install Bun (test runner only); configure DOM environment and test setup preloads.
- Codemod Vitest imports/APIs to Bun test equivalents (`vi.*` to `jest.*`-compatible or `bun:test` mocks).
- Migrate directory by directory; run both runners in CI during the transition (each suite runs under exactly one runner to avoid double execution).
- Wire coverage output into the existing gate.
- Remove Vitest once all suites are migrated.
- Exit criteria: all suites green under Bun test, coverage gate intact, flake rate stable for two weeks.

### Phase 5: Cleanup
- Remove tsc fallback, ESLint/Prettier/Vitest remnants, dead config files, and unused devDependencies.
- Record post-migration timings against the Phase 0 baseline and publish results.
- Update onboarding docs.

## 9. Exception Process

Some capabilities may not have a 1:1 replacement (custom ESLint rules, niche Stylelint plugins, Vitest-only features like in-source testing or browser mode). For each:

1. File a ticket describing the gap and its current value.
2. Decide: drop the rule/feature, find an Oxlint/Gale/Bun equivalent, or retain the legacy tool scoped to only that concern with a removal date.
3. No open exceptions without an owner at the end of Phase 5.

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bun test incompatibilities (module mocking semantics, fake timers, snapshot format, jsdom edge cases) | High | High | Phase 4 is directory-by-directory with parallel CI; hard fallback is keeping Vitest (Vitest itself is getting faster via Rolldown, so this fallback is acceptable and should be decided by end of Phase 4, sprint 1). |
| Next.js module mocking under Bun test (`mock.module` semantics differ from `vi.mock`: no hoisting, possible cross-file leakage) | High | High | Phase 0 mock inventory sizes the problem; centralize Next mocks in shared preload files; if mock volume is high, keep Vitest (fallback per Open Question 1). |
| Oxlint nextjs plugin gaps versus `eslint-config-next` | Medium | Medium | Rule-mapping diff in Phase 2; parallel ESLint run catches misses; file gaps upstream or accept via exception process. |
| Oxlint missing a rule the team relies on | Medium | Medium | Rule-mapping doc in Phase 2 plus one week of parallel ESLint runs; Oxlint supports custom rules via its plugin system for gaps worth keeping. |
| tsgo diagnostic differences from tsc | Medium | High | Two-sprint parallel run; tsgo version pinned and synced with tsgolint. |
| Oxfmt output differs from Prettier in edge cases | Low | Low | Conformance is at 100% for JS/TS; single reformat commit absorbs any drift; report divergences upstream. |
| Gale gaps versus Stylelint plugins | Medium | Medium | FR-4 inventory; Stylelint can remain scoped to unsupported rules temporarily. |
| Tool immaturity / breaking changes (Oxfmt is newly out of beta) | Medium | Medium | Pin exact versions with `--save-exact`; upgrade deliberately, not automatically. |
| Team learning curve and editor setup friction | Low | Low | Committed `.vscode` settings, migration guide, pairing during Phase 2. |

## 11. Success Metrics

- Lint, format, and typecheck timings versus Phase 0 baseline (targets in Section 7.2).
- CI pipeline duration for the quality stage (target: under 60s warm).
- Number of open exceptions at end of Phase 5 (target: 0).
- Developer survey (before/after): satisfaction with local feedback loop.
- devDependency count reduction (informational).

## 12. Rollback Plan

Each phase is independently reversible until Phase 5 cleanup:

- Formatting: revert to Prettier config (kept in git history); reformat commit stays.
- Linting: ESLint config retained in a branch until Phase 5.
- Type checking: tsc script retained until Phase 5.
- Testing: per-directory migration means partial rollback is a config change, not a code revert.

## 13. Open Questions

1. Do we adopt Bun test now, or keep Vitest and revisit in two quarters once Bun's React/DOM testing story matures further? (Decision owner: frontend lead, due end of Phase 0.)
2. Are there custom ESLint rules worth porting to Oxlint's plugin system, or do we drop them all?
3. Does any consumer depend on Prettier's exact Markdown output (e.g., generated docs pipelines)?
4. Monorepo considerations: do we run these tools as root tasks or per-package scripts for cache efficiency?

## 14. Timeline Summary

| Phase | Duration | Owner |
|---|---|---|
| 0: Baseline and audit | 0.5 sprint | Frontend lead |
| 1: Formatting (Oxfmt) | 0.5 sprint | TBD |
| 2: Linting (Oxlint + Gale) | 1 sprint | TBD |
| 3: Type checking (tsgo) | 0.5 sprint (plus 2-sprint parallel run) | TBD |
| 4: Testing (Bun test) | 1 to 2 sprints | TBD |
| 5: Cleanup and report | 0.5 sprint | Frontend lead |
