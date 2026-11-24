---
name: pr-creator
description: Create, draft, format, validate, or open pull requests for the wizteros repository according to its CLAUDE.md rules. Use when asked to "create a PR", "open a pull request", "draft the PR", "write a PR title/body", or check PR formatting for a branch in wizteros.
---

# Create wizteros pull requests

Follow the repository's current rules and create a pull request only when the user has
explicitly asked for one.

## Respect authorization boundaries

- Read the repository-root `CLAUDE.md` before preparing a pull request. Treat it as the
  source of truth when it differs from this skill.
- Treat requests to create or open a pull request as authorization for that action only.
  Do not create or switch branches, commit, push, or merge unless the user separately
  authorizes those actions.
- For requests to draft, write, format, review, or validate PR text, return the proposed
  title and body without opening a pull request.

## Inspect the branch

1. Confirm the current repository root and current branch.
2. Determine the remote's default branch and use it as the base unless the user names a
   different base.
3. Inspect the complete committed branch diff and commit history against the base. Do not
   derive the PR from only the latest commit or the working-tree diff.
4. Check for uncommitted changes and report that they will not be included in the PR.
5. Check whether the current branch already has a pull request. Do not create a duplicate;
   return the existing PR instead.
6. Confirm every intended commit exists on the remote branch. If a push is required, stop
   with the prepared title and body and ask for explicit push authorization.

Typical inspection commands are:

```bash
git rev-parse --show-toplevel
git status --short --branch
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
git log --oneline <base>..HEAD
git diff --stat <base>...HEAD
git diff <base>...HEAD
git branch -vv
gh pr list --head <head> --state all --json url,title,state
```

Use equivalent GitHub tooling when `gh` is unavailable.

## Format the pull request

- Start the title with exactly `WZ: `, followed by a short, specific description of the
  branch's logical change.
- Structure the body as bullet sections, in this order:
  - `## What` — required. One `- ` bullet per change, one concept per bullet.
  - `## Why` — one bullet per reason: the problem or gap behind the change, stated from
    the user/system's perspective rather than as a restatement of the diff. Omit the
    section when the title already says it.
  - `## Verified` — one bullet per check that actually ran, with its result
    (`` `bun run verify` green ``, a manual run and what it showed). Include it whenever
    anything was run; omit it otherwise, and never imply that unrun checks passed.
- Add another section only when the PR genuinely needs one (`## Behaviour to note` for a
  change a reader would trip over, `## After merge` for steps such as `bun run deploy:nas`,
  `## Screenshots` for portal changes). It goes between `## Why` and `## Verified`.
- The body is bullets, never prose. Use `-`, not `*`. Keep each bullet to one line with no
  trailing period, and to roughly eight per section; more means rolling bullets up or
  splitting the PR.
- Backtick anything that reads as code in the body: commands, flags, paths, identifiers,
  env vars. A multi-area PR may lead a bullet with its scope (`` `loops.ts`: … `` or
  `**admin-portal**: …`).
- Describe only changes present in the committed branch diff, and do not restate the diff.
- Omit boilerplate, repeated title text, empty headings, footers, and speculative
  follow-up work.

Example:

```text
WZ: Add subscription renewal handling

## What

- `webhook/handlers.ts`: handle `invoice.paid` and extend the member's expiry
- regression coverage for renewal state changes

## Why

- renewal webhooks were received but never updated a member's expiry
- so paid renewals silently lapsed

## Verified

- `bun run verify` green
- `bun run test:e2e` renews a test-mode subscription and the expiry moves
```

Before creation, validate that the title matches `WZ: <short title>`, that the body opens
with `## What`, that every section is bullets, and that `## Verified` lists only checks
that ran, staying minimal under the current `CLAUDE.md` rules.

## Create and verify

Prefer the connected GitHub integration when available. Otherwise, create the pull request
with explicit values rather than `--fill`:

```bash
gh pr create --base <base> --head <head> --title '<title>' --body '<body>'
```

Add `--draft` only when the user requests a draft. After creation, read the pull request
back from GitHub, verify its title, body, base, head, and draft state, then return its URL.
