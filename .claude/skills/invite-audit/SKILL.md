---
name: invite-audit
description: Use when the wizteros invitation set needs checking — the four per-tier baseline links, their expiry, their scope, or whether the 03:00 rotation is still running. Triggers include "audit the invitations", "check the invite links", "are the baseline invites still good", "why is there no bronze link", "did the invite rotation run", "these invites never expire", or a Wizarr invitation grid that looks wrong. Read-only: it reports and never creates, deletes, or edits an invite. Only applies to the wizteros repo.
---

# Invitation audit

## Overview

The invitation set has two populations that must never be confused.

**Baseline invites** are the four multi-use links — one per tier — handed to
prospective members. The bridge mints them and rotates them daily at 03:00
(`stripe_bridge/baseline.py`, driven by `_baseline_loop`). They are the only invites
this skill judges.

**Member invites** are minted per checkout by the webhook handler, single-use, tied
to one buyer. They are listed for context and are none of this skill's business.

Ownership is recorded, not inferred: every code the bridge mints is written to
`baseline_invites` in `bridge.db`. That table is the sole definition of "ours", which
is what makes the rotation safe to run unattended — a member's checkout invite cannot
appear in it, so it can never be reaped.

**Nothing here mutates.** The audit script only reads; rotation happens in the bridge
on the NAS. The remedies below are either a bridge deploy or a deliberate click in
Wizarr by a human.

## Running it

```bash
node --env-file=.env .claude/skills/invite-audit/scripts/audit-invites.mjs
```

Run it from the repo root. Needs `WIZARR_BASE_URL` and `WIZARR_API_KEY`, plus SSH key
auth to the NAS and `sudo -n /usr/local/bin/docker` there to read `baseline_invites`.
`.env` is gitignored, so whether one exists is a property of the working copy: use it
when present, otherwise point `--env-file` at whatever file holds the values.

Exit code is 1 when there are findings, 0 when clean, 2 on a config or connection
failure. `WZ_NAS_HOST` (default `crivas@192.168.50.2`) points at another NAS.

The bridge-store section is the one that degrades: without it the script cannot tell
a baseline from a stray, so it says so and nothing below that line is conclusive.
Treat that as "audit did not run", not "audit found nothing".

## The rules being checked

| Rule                         | Why                                                     |
| ---------------------------- | ------------------------------------------------------- |
| Four tiers always live       | bronze, gold, silver, youth each need a redeemable link |
| Every baseline has an expiry | a leaked link that never expires is redeemable forever  |
| Scope is `Meleys` alone      | `tiers.py` retires the other servers from signups       |
| Downloads follow the tier    | only gold and youth may download                        |
| Newest baseline < 26h old    | proves the 03:00 rotation is still running              |

Scope is judged on `server_names`, **never** `specific_libraries`. Wizarr's invitation
serializer reports `specific_libraries: []` even for a correctly scoped invite, so
that field cannot tell a scoped invite from an unscoped one. Do not "fix" an invite
because that array looks empty.

## Case 1: a tier has no live baseline invite

**Dossier.** `bronze  none live`, and the other tiers may be fine.

The floor is four, and two generations normally overlap, so a single missing tier
means minting failed for that tier specifically — not that rotation is down.

- **Scope broke.** Check the bridge logs for `baseline: skipping <tier>` or
  `no libraries resolved`. A Plex library rename narrows or empties a tier, and
  `tier_scope_problems` then refuses to mint rather than issue an empty invite.
  This is the same root cause as case 4 in `member-triage`, and it breaks checkouts
  too, so fix it there: correct the library name on Plex or update `tiers.py`, run
  `bun run refresh:libraries` and `bun run test:bridge`, then deploy.
- **Wizarr rejected the create.** A traceback under `baseline: minting <tier> failed`.
  Usually auth or a Wizarr upgrade changing the payload.

**Remedy.** Fix the cause, then wait for 03:00 or restart the bridge container to get
a rotation on the next cycle. Do not hand-create a replacement in Wizarr: it would not
be recorded in `baseline_invites`, so it would show up as a stray forever and never
rotate.

## Case 2: a baseline invite never expires

**Dossier.** `[NO EXPIRY]` against a bridge-minted code.

The rotation always passes `expires_in_days`, so a bridge-minted invite with a null
expiry means someone cleared it by hand in Wizarr, or the invite predates the
rotation.

**Remedy.** Leave it. The next rotation mints a replacement, and this one is reaped
once its recorded `expires_at` passes. Deleting it by hand is safe but pointless —
and if you do, the audit will report a missing tier until 03:00.

## Case 3: strays — unlimited invites the bridge did not mint

**Dossier.** A `Strays` section with codes, usually `expires NEVER` and naming
retired servers.

This is the expected finding on any stack that ran before the rotation existed. The
four original baseline invites (`1PYO3B8VPQ`, `F30UFPPXOV`, `KYJZKJRGVZ`,
`VPWG3JK2PS`, minted 2026-07-16) are exactly this: never-expiring, and scoped to
Vermithor, Vhagar, Caraxes, and Syrax — servers `tiers.py` says "must never be granted
again". Anyone redeeming one gets access the tier rules forbid.

**Remedy.** Delete them in the Wizarr UI once the rotation has produced its
replacements — confirm four tiers show live first, then delete. **The audit will never
delete a stray for you**, because it cannot prove a stray is not something you created
deliberately. That judgment is yours.

## Case 4: rotation has stopped

**Dossier.** Findings say the newest baseline for a tier is older than 26 hours,
usually across all four at once.

- **Bridge is down or was restarted repeatedly.** `_baseline_loop` deliberately does
  not rotate at boot — a restart loop would otherwise mint a fresh set every time the
  container came up — so a bridge that keeps restarting never reaches 03:00.
- **The deployed bridge predates the rotation.** The audit says the
  `baseline_invites` table is absent. `GET /version` against the NAS, compare with
  `__version__`, and deploy.

**Remedy.** `bun run deploy:nas` (or the `deploy-nas` skill), then confirm with
`GET /version`. Netlify does not carry the bridge; the NAS only updates when told.

## Case 5: a baseline grants more than Meleys

**Dossier.** `[SCOPE Meleys,Syrax,Vermithor]` on a bridge-minted code.

This should be impossible: the rotation derives scope from
`tiers.resolve_tier_access`, which filters to `SHARE_SERVER`. Seeing it on a
bridge-minted invite means either someone edited the invite in Wizarr, or
`SHARE_SERVER` changed without the retired-server comment being revisited.

**Remedy.** Read `tiers.py:9-14` first and decide which is true. If a server is being
un-retired that is a tier-rules change with tests behind it, not an invite fix.

## Where each remedy happens

| Remedy                       | Where                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| Fix a tier's library set     | `tiers.py` + Plex library names, then `refresh:libraries`, test, deploy |
| Ship the rotation to the NAS | `bun run deploy:nas`, confirm `GET /version`                            |
| Force a rotation now         | restart the bridge container and wait for 03:00, or wait a day          |
| Delete a stray invite        | Wizarr UI, by hand, after confirming replacements exist                 |
| Change the rotation hour     | `BASELINE_ROTATE_HOUR` in the NAS `.env`, then rebuild                  |
| Change the link lifetime     | `BASELINE_EXPIRES_DAYS` (default 2), same                               |

## Reporting back

Lead with whether the four-tier floor currently holds, since that is the only finding
a prospective member can actually feel. Then the specific broken invites, then the one
remedy and who presses it.

Say plainly when a finding is systemic rather than per-invite: a tier that cannot
resolve breaks every future checkout for that tier, not just its baseline link.

If the bridge-store section was unavailable, say so and stop short of conclusions —
without it, baseline and stray are indistinguishable.

## Red flags

- Never hand-create a "replacement" baseline invite in Wizarr. It will not be in
  `baseline_invites`, so it will never rotate and will read as a stray forever.
- Never delete a stray on the audit's say-so alone. It cannot know what you created
  on purpose.
- Never judge scope by `specific_libraries` — it is `[]` on correctly scoped invites.
- A missing expiry on a _member_ invite is not this skill's problem; member invites
  are governed by `INVITE_EXPIRES_DAYS` and diagnosed with `member-triage`.
- Do not lower `BASELINE_EXPIRES_DAYS` to 1 "so links die sooner". At 1 day the
  overlap disappears and a link shared minutes before 03:00 dies almost immediately.
