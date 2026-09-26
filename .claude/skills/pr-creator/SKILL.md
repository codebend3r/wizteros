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
- Structure the body as two short sections, in this order:
  - `## Problem` — one plain sentence naming the problem or gap this PR addresses. State
    it from the user/system's perspective, not as a restatement of the diff (e.g. "Renewal
    webhooks weren't updating member expiry" rather than "Add webhook handler").
  - `## Changes` — concise `- ` bullet points describing what the PR actually does.
- Keep the body minimal overall: one sentence under `Problem`, and only as many bullets
  under `Changes` as there are distinct logical changes.
- Describe only changes present in the committed branch diff.
- Mention verification only when it actually ran; never imply that unrun checks passed.
- Omit boilerplate, repeated title text, empty headings, and speculative follow-up work.
- If the branch is a pure refactor, chore, or tooling change with no user-facing problem
  to name, state that plainly under `Problem` (e.g. "No behavior change; simplifies X for
  maintainability") rather than inventing a problem.

Example:

```text
WZ: Add subscription renewal handling

## Problem
Renewal webhooks were received but never updated a member's expiry, so paid renewals
silently lapsed.

## Changes
- process successful renewal webhooks
- add regression coverage for renewal state changes
```

Before creation, validate that the title matches `WZ: <short title>` and that the body
has exactly the `## Problem` / `## Changes` structure above, staying minimal under the
current `CLAUDE.md` rules.

## Create and verify

Prefer the connected GitHub integration when available. Otherwise, create the pull request
with explicit values rather than `--fill`:

```bash
gh pr create --base <base> --head <head> --title '<title>' --body '<body>'
```

Add `--draft` only when the user requests a draft. After creation, read the pull request
back from GitHub, verify its title, body, base, head, and draft state, then return its URL.
