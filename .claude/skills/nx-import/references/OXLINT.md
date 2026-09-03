## Oxlint and Oxfmt

Lint and format guidance for `nx import`. For generic import issues (root deps, pnpm globs, project references), see `SKILL.md`.

This workspace lints with [oxlint](https://oxc.rs) and formats with [oxfmt](https://oxc.rs). SCSS is additionally linted by stylelint, Python by ruff. There is no other linter or formatter, and an imported project must not reintroduce one.

---

### Config Scope

Two independent passes, and they never overlap:

| Pass    | Config                                                  | Covers                                                                                                                                     |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Root    | `.oxlintrc.json`, `.oxfmtrc.json` at the repo root      | Everything outside `apps/` — `scripts/**/*.mjs`, `.claude/skills/**`, docs, root config files. Both files list `apps` in `ignorePatterns`. |
| Per app | `apps/<app>/.oxlintrc.json`, `apps/<app>/.oxfmtrc.json` | That app only                                                                                                                              |

The root pass is a plain script (`bun run lint:root`, `bun run format:root`), not an Nx target, because the repo root is not an Nx project. `bun run lint`, `format`, `format:check`, and `verify` run the root pass first and then fan out to the projects.

An imported project lands under `apps/`, so it is invisible to the root pass and needs its own pair of configs.

---

### Converting an Imported Project

1. **Delete the source's lint and format setup.** Every config file it shipped, at the repo root and inside the project, plus every dependency that only existed to serve them. Do not leave one behind "in case" — a second linter over the same files is drift by definition.

2. **Add the deps**, pinned to the same versions the other apps use so the root pass and the per-app passes never disagree:

   ```jsonc
   // apps/<app>/package.json
   "devDependencies": {
     "oxfmt": "0.61.0",
     "oxlint": "1.76.0"
   }
   ```

3. **Copy the configs** from `apps/admin-portal/` and trim what does not apply. `.oxfmtrc.json` is identical across the repo apart from `ignorePatterns`; only `.oxlintrc.json` needs real thought — drop the `react` and `jsx-a11y` plugins for a non-React project, keep the `// Conventions from CLAUDE.md` block verbatim.

4. **Add the scripts and whitelist them**, or Nx will not infer the targets:

   ```jsonc
   // apps/<app>/package.json
   "scripts": {
     "lint:ts": "oxlint",
     "lint:ts:fix": "oxlint --fix",
     "format": "oxfmt .",
     "format:check": "oxfmt --check ."
   },
   "nx": {
     "includedScripts": ["lint:ts", "lint:ts:fix", "format", "format:check"]
   }
   ```

   `bun run lint` and `bun run verify` pick the project up automatically once the targets exist, since both go through `nx run-many`.

5. **Add a `.lintstagedrc.json`** at the project root. Commands must spell out `node_modules/.bin/<tool>` — bun keeps the bins in the app, not at the repo root:

   ```json
   {
     "*.{ts,tsx}": ["node_modules/.bin/oxlint --fix", "node_modules/.bin/oxfmt"],
     "*.{js,jsx,mjs,cjs,json,md,yml,yaml,html,css}": ["node_modules/.bin/oxfmt"]
   }
   ```

6. **Reformat once** with `nx run <app>:format`, in its own commit, so the style change never mixes with a behavioral one.

---

### Rule Names

Oxlint namespaces rules by plugin (`typescript/no-explicit-any`, `unicorn/prefer-array-flat-map`, `import/no-default-export`). Its core rules take no prefix at all: write `no-var`, `prefer-const`, `eqeqeq`, `no-console`. Any plugin outside the core set has to be listed in `"plugins"` before its rules resolve.

Porting rules from another linter is a per-rule judgement, not a mechanical rename. A rule with no oxlint equivalent gets dropped and noted in a comment, never kept alive by reinstalling the tool it came from.

---

### Disable Directives

Oxlint reads `oxlint-disable`, `oxlint-disable-next-line`, and `oxlint-disable-line`. Use those spellings; the repo has no other linter whose directives could apply.

```ts
// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
```

Every suppression carries a comment above it saying why the tradeoff is deliberate. `apps/admin-portal/src/components/ConfirmActionModal/ConfirmActionModal.tsx` is the pattern to copy. An undocumented suppression reads as drift, and the `wizteros-reviewer` agent will flag it.

---

### Targets, Not Prefixes

`@nx/eslint/plugin` is not installed and must not be, so there are no inferred `lint` targets to collide with and no prefixed `lint` target names to untangle. Every lint and format target in this repo comes from a `package.json` script gated by `nx.includedScripts`. If `nx show project <app>` does not list `lint:ts`, the script is missing from that array.

---

### Verification

```bash
bun run lint:root          # root pass only
nx run <app>:lint:ts       # the imported app only
bun run verify             # root pass, then lint, format check, typecheck, tests everywhere
```

`bun run verify` is what pre-push runs; treat a green `verify` as the bar for a finished import.
