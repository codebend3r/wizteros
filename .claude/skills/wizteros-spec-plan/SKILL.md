---
name: wizteros-spec-plan
description: Use when writing a design doc, spec, plan, or PRD in the wizteros repo, when starting a feature that needs designing before coding, or when looking for the prior design of an existing feature. Covers where these documents live, the dated filename convention, and which existing document to read for a given subsystem.
---

# wizteros Specs and Plans

## Overview

The repo has an established design-doc convention with 13 specs and 7 plans already written. New documents that ignore it become unfindable.

## Where documents go

| Kind | Location | Filename |
|---|---|---|
| Design spec | `docs/superpowers/specs/` | `YYYY-MM-DD-<slug>-design.md` |
| Implementation plan | `docs/superpowers/plans/` | `YYYY-MM-DD-<slug>.md` |
| Product requirements | `docs/prd/` | `<slug>-prd.md` |
| Operational runbook | `docs/` | `<slug>.md` |

A spec and its plan share the same date and slug; the plan simply drops the `-design` suffix. Use the date the work starts, not the date of a later revision.

```
docs/superpowers/specs/2026-07-17-admin-pages-design.md
docs/superpowers/plans/2026-07-17-admin-pages.md
```

Specs run roughly 2k to 12k, plans 9k to 67k. Plans are substantially longer because they carry the step-by-step implementation detail.

Both apps share `docs/`. There is no `web/docs` or `stripe-bridge/docs`.

## Existing documents worth reading first

| Subsystem | Read |
|---|---|
| Tier rules, library scoping | `specs/2026-07-13-plex-subscription-tiers-design.md`, `specs/2026-07-16-subscription-tiers-design.md` |
| Multi-server access, fail-closed behaviour | `specs/2026-07-13-multi-server-failsafe-access-design.md` |
| Admin pages, members table, member detail | `specs/2026-07-17-admin-pages-design.md`, `plans/2026-07-17-admin-pages.md` |
| Invite page and redemption | `specs/2026-07-20-invite-page-design.md` |
| Member status derivation | `specs/2026-07-24-invited-status-subscribed-signal-design.md` |
| Landing page | `specs/2026-07-13-westeroz-landing-page-design.md` |
| Login and admin auth | `specs/2026-07-23-supabase-login-design.md` |
| Toolchain (bun, oxlint, gale, tsgo) | `specs/2026-07-23-toolchain-removal-bun-migration-design.md`, `docs/prd/tooling-migration-prd.md` |
| Invite email | `specs/2026-07-15-styled-invite-email-design.md` |
| Stripe customer links | `specs/2026-07-31-stripe-customer-link-design.md` |

Runbooks live at the `docs/` root: `invite-flow.md`, `nas-deployment.md`, `tailscale-funnel.md`.

## Which document to write

- **Spec** when the shape of the thing is not obvious: competing approaches, cross-cutting changes, or member-visible behaviour changes. Covers the problem, the chosen design, and the tradeoffs rejected.
- **Plan** when the spec is settled and the work spans several files or both apps. Covers the ordered steps.
- **Neither** for a bugfix or a self-contained change. Do not manufacture a spec for a one-file edit.

## Writing rules

- No en dashes or em dashes anywhere, per the repo owner's global style rule.
- Reference code with backticked paths relative to the repo root: `stripe-bridge/stripe_bridge/tiers.py`, `web/src/lib/memberStatus.ts`.
- Record the fail-closed reasoning when a design touches access. The existing specs do this consistently and it is why the invariants in `tiers.py` survived later changes.
- Update the runbook when a design changes behaviour it documents. `docs/invite-flow.md` quotes both `INVITE_EXPIRES_DAYS` and `ACCESS_DURATION`, so a duration change makes it stale.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Undated filename | Use `YYYY-MM-DD-<slug>` |
| Spec in `docs/` root | Specs go in `docs/superpowers/specs/` |
| Plan named `-design` | Only specs carry `-design` |
| New doc restating an existing spec | Read the table above first |
| Behaviour change without updating `invite-flow.md` | Update the runbook in the same commit |
