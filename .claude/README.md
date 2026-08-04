# Claude Code configuration

Repo-scoped skills, subagents, and settings for wizteros. These live in the repo (rather than `~/.claude/`) so they stay versioned alongside the code they describe and do not rot when files move.

`CLAUDE.md` at the repo root remains the always-loaded context. These skills and agents carry the procedural detail that would bloat it.

## Skills

Loaded on demand when the task matches the description. Invoke by name, or let the description trigger them.

| Skill | Use when |
|---|---|
| `wizteros-commit-format` | Writing or rewriting any commit message. `WZ:` prefix, bullets, no agent attribution. |
| `wizteros-pr-format` | Creating or updating a PR. `WZ:` title, minimal bullet body. |
| `wizteros-tier-change` | Adding, renaming, repricing, or re-scoping a tier. Walks the eight places a tier is defined. |
| `wizteros-verify` | Running checks, or a hook or CI failed. Which gate to run and how to read each tool. |
| `wizteros-config-drift-check` | Changing an env var or a duration. Four hand-mirrored sources of truth. |
| `wizteros-deploy` | Releasing, deploying to the NAS, or restarting containers. |
| `wizteros-webhook-e2e` | Testing or debugging Stripe webhook flows. |
| `wizteros-spec-plan` | Writing a design doc or plan, or finding the prior design of a feature. |
| `stripe-bridge-migration` | Adding a column or table to the bridge's SQLite, or writing a backfill. |

## Agents

Separate context windows for review work. Dispatch with the Agent tool.

| Agent | Reviews |
|---|---|
| `plex-access-safety-review` | Access-path invariants in the bridge. The highest-consequence review: private-library leaks and lockouts. |
| `wizteros-house-style-review` | The `CLAUDE.md` house rules that no linter enforces. |
| `wizteros-responsive-a11y-audit` | The 320px no-horizontal-scroll requirement and the a11y checklist. |
| `wizteros-payment-copy-compliance` | Plex and Stripe terms-of-service framing on payment surfaces. |
| `wizteros-secret-hygiene` | Leaked credentials, weakened deploy exclusions, secrets in `VITE_*` vars. |

## Suggested review pairings

- Bridge change touching access: `plex-access-safety-review`
- New or changed UI: `wizteros-house-style-review` plus `wizteros-responsive-a11y-audit`
- Anything on a payment or onboarding surface: add `wizteros-payment-copy-compliance`
- Before any push or deploy: `wizteros-secret-hygiene`

## settings.json

- **allow**: read-only inspection plus the local test, lint, and typecheck gates, so routine verification does not prompt.
- **ask**: anything that leaves the machine or mutates live state. Deploy, release, push, PR create and merge, the e2e loop (it mutates a real Wizarr member), and `rsync`.
- **deny**: `.env` and the three live data directories, so credentials and member state are never read into context.
- **hooks**: `PostToolUse` runs `oxfmt` on edited TS, JS, and JSON files so formatting never fails the pre-commit gate.
