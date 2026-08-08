---
name: commiter
description: Enforce wizteros commit and pull-request formatting. Use whenever preparing, writing, validating, or creating a git commit or pull request, including requests such as "commit this", "write a commit message", "open a PR", "prepare the PR", or "check this commit/PR title". Only applies to the wizteros repo.
---

# Enforce commit and pull-request formatting

Read the `Workflow`, `Commits`, and `Pull Requests` sections of the repository-root
`CLAUDE.md` before preparing any commit or pull request. Treat that file as the source
of truth if its rules change.

## Authorization

Do not interpret this skill's activation as permission to commit, push, create a branch,
open a pull request, or merge. Perform only the git or GitHub action the user explicitly
authorized.

## Commits

1. Inspect the staged diff and repository status before writing the message.
2. Keep each commit to one logical change; combine related files and separate unrelated
   work.
3. Start the subject with `WZ: ` followed by a short, specific title.
4. Use a concise bullet-list body when context beyond the subject is useful. Omit the
   body when it adds no value.
5. Reject or rewrite a message whose subject does not match `WZ: <short title>`.
6. Before committing, verify that only the intended files are staged.

Example:

```text
WZ: Add subscription renewal handling

- process successful renewal webhooks
- cover renewal state changes with tests
```

## Pull requests

1. Review the complete branch diff and commit history before drafting the pull request.
2. Start the title with `WZ: ` followed by a short, specific title.
3. Keep the body minimal and favor concise bullet points.
4. Reject or rewrite a title that does not match `WZ: <short title>`.
5. Confirm the title and body comply with the current `CLAUDE.md` rules before creating
   or updating the pull request.

Example:

```text
WZ: Add subscription renewal handling

- process successful renewal webhooks
- add regression coverage
```
