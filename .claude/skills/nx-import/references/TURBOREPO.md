## Turborepo

- Nx replaces Turborepo task orchestration, but a clean migration requires handling Turborepo's config packages.
- Migration guide: https://nx.dev/docs/guides/adopting-nx/from-turborepo#easy-automated-migration-example
- Since Nx replaces Turborepo, all turbo config files and config packages become dead code and should be removed.

## The Config-as-Package Pattern

Turborepo monorepos ship with internal workspace packages that share configuration:

- **`@repo/typescript-config`** (or similar) — tsconfig files (`base.json`, `nextjs.json`, `react-library.json`, etc.)
- **`@repo/lint-config`** (or similar) — the source's linter and formatter config files plus all their plugin dependencies

These are not code libraries. They distribute config via Node module resolution (e.g., `"extends": "@repo/typescript-config/nextjs.json"`). This is the **default** Turborepo pattern — expect it in virtually every Turborepo import. Package names vary — check `package.json` files to identify the actual names.

## Check for Root Config Files First

**Before doing any config merging, check whether the destination workspace uses shared root configuration.** This decides how to handle the config packages.

- **TypeScript**: if the workspace has a root `tsconfig.base.json` that projects extend, merge the config package into it (see steps below).
- **Lint and format**: this workspace never shares those from the root — `.oxlintrc.json` and `.oxfmtrc.json` at the repo root ignore `apps` outright, and each app owns its own pair. There is nothing to merge into; the source's config package is deleted and the imported project gets its own configs per `OXLINT.md`.

If unclear about the TypeScript side, check for the presence of `tsconfig.base.json` at the root or ask the user.

## Merging TypeScript Config (Only When Root tsconfig.base.json Exists)

The config package contains a hierarchy of tsconfig files. Each project extends one via package name.

1. **Read the config package** — trace the full inheritance chain (e.g., `nextjs.json` extends `base.json`).
2. **Update root `tsconfig.base.json`** — absorb `compilerOptions` from the base config. Add Nx `paths` for cross-project imports (Turborepo doesn't use path aliases, Nx relies on them).
3. **Update each project's `tsconfig.json`**:
   - Change `"extends"` from `"@repo/typescript-config/<variant>.json"` to the relative path to root `tsconfig.base.json`.
   - Inline variant-specific overrides from the intermediate config (e.g., Next.js: `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"jsx": "preserve"`, `"noEmit": true`; React library: `"jsx": "react-jsx"`).
   - Preserve project-specific settings (`outDir`, `include`, `exclude`, etc.).
4. **Delete the config package** and remove it from all `devDependencies`.

## Replacing the Lint Config Package

The config package centralizes the source's linter and formatter plugins and exports composable configs. None of it survives; it is replaced, not merged.

1. **Read the config package** — note which rules the source actually enforced, so the ones worth keeping can be ported by hand.
2. **Give each imported project its own `.oxlintrc.json` and `.oxfmtrc.json`** at its root, modelled on `apps/admin-portal/`. Port the rules that still matter; drop the rest with a comment.
3. **Add `lint:ts`, `lint:ts:fix`, `format`, and `format:check` scripts** to each project's `package.json` and list them in `nx.includedScripts` so Nx infers the targets. See `OXLINT.md`.
4. **Delete the config package** and remove it, and every plugin dependency it carried, from all `devDependencies`.

## General Cleanup

- Remove turbo-specific dependencies: `turbo`, plus any turbo linter plugin the source installed.
- Delete all `turbo.json` files (root and per-package).
- Run workspace validation (`bun run verify`) to confirm nothing broke.

## Key Pitfalls

- **Trace the full inheritance chain** before inlining — check what each variant inherits from the base.
- **Module resolution changes** — from Node package resolution (`@repo/...`) to relative paths (`../../tsconfig.base.json`).
- **The source's lint config is probably JavaScript, `.oxlintrc.json` is JSON** — rules have to be read out and rewritten by hand, not spread or imported.

Helpful docs:

- https://nx.dev/docs/guides/adopting-nx/from-turborepo
