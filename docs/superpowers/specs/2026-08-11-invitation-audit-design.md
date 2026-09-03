# Baseline invitation audit and rotation

Date: 2026-08-11

## Problem

Wizarr currently holds four multi-use "baseline" invites — the links handed out to
prospective members, one per tier. All four are broken in the same two ways:

- **They never expire.** `expires: null` on every one, so a link leaked once is
  redeemable forever.
- **They grant retired servers.** Each was minted 2026-07-16 against Vermithor,
  Vhagar, Caraxes, and Syrax. `tiers.py:9-14` states those servers are retired from
  signups and "must never be granted again" — every tier now resolves to
  `SHARE_SERVER` (Meleys) alone. Anyone redeeming one gets access the tier rules
  forbid.

Nothing regenerates or checks these invites, so both problems are permanent and
invisible.

## Goals

1. Always at least four live baseline invites, one per tier (bronze, silver, gold,
   youth).
2. Every baseline invite carries a real expiry.
3. Baselines rotate daily at 03:00 so a leaked link has a short life.
4. An on-demand audit that reports drift without changing anything.

## Non-goals

- Touching member checkout invites. Those are issued per-session by the webhook
  handler and are none of this system's business.
- Deleting anything a human created by hand in Wizarr. The audit reports strays; it
  never removes them.

## Architecture

Two artifacts, split by whether the work is mechanical or judgment.

### 1. Bridge-side rotation (mechanical, runs unattended)

| Piece                                   | Change                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `stripe_bridge/wizarr.py`               | add `list_invitations()` and `delete_invitation(id)`            |
| `stripe_bridge/store.py`                | add `baseline_invites` table plus accessors                     |
| `stripe_bridge/baseline.py`             | new: `rotate_baseline_invites()` and `audit_baseline_invites()` |
| `stripe_bridge/stripe_wizarr_bridge.py` | add `_baseline_loop()` to the lifespan task list                |

The `DELETE /api/invitations/{id}` verb is already exercised by
`apps/stripe-bridge/scripts/e2e-tiers.mjs:181`, so no new API surface is being
assumed.

### 2. `.claude/skills/invite-audit/` (judgment, runs on demand)

Same shape as `member-triage`: a read-only gather script that prints a dossier, and
a `SKILL.md` that maps each finding to one remedy. **No subagent.** The checks are
deterministic table comparisons; an agent wrapper would add indirection without
adding judgment, which is why `member-triage` is skill-only too.

## What a baseline invite is

One per tier in `TIER_DOWNLOADS` — bronze, silver, gold, youth.

Scope comes from `tiers.resolve_tier_access(tier=..., libraries=...)`, the same
function the checkout path uses. This is the crux of the fix: the baseline set is
_derived_ from the live tier rules rather than frozen at creation time, so it is
structurally incapable of granting a retired server or a stale library set.

| Property                     | Value                                               |
| ---------------------------- | --------------------------------------------------- |
| `library_ids` / `server_ids` | `resolve_tier_access(tier)` — Meleys only           |
| `allow_downloads`            | `TIER_DOWNLOADS[tier]`                              |
| `duration`                   | `ACCESS_DURATION` (35 days of access once redeemed) |
| `expires_in_days`            | `2` — link validity, distinct from duration         |
| `unlimited`                  | `true` — baselines are multi-use signup links       |

## Rotation

Fires on wall-clock 03:00 local, by sleeping until the next occurrence rather than on
a fixed interval, so it does not drift after a restart.

**Rotation never revokes a live link.** Each run mints a fresh invite per tier and
reaps only baselines that have already passed their own expiry. A code always dies by
its own clock, never yanked out from under someone who just shared it.

```
03:00 Mon   mint A          live: A
03:00 Tue   mint B          live: A, B      (A expires Wed 03:00)
03:00 Wed   mint C, reap A  live: B, C
```

Steady state is two live generations per tier — eight baseline invites, above the
four-minimum floor. The floor holds even if a rotation is missed entirely, because
the previous generation is still valid for another 24 hours.

Order within a run is **mint, then reap**. A failure part-way through leaves extra
invites rather than none.

## Ownership and the deletion guard

Rotation deletes an invite only when both hold:

1. Its code is present in `baseline_invites` — i.e. this system minted it.
2. Its `expires` is in the past.

A member checkout invite can never satisfy (1), so it can never be deleted. Anything
unlimited that is _not_ in `baseline_invites` is surfaced by the audit as a stray and
left alone.

```sql
CREATE TABLE IF NOT EXISTS baseline_invites (
    code       TEXT PRIMARY KEY,
    tier       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
)
```

## Audit checks

| Check             | Fails when                                                   |
| ----------------- | ------------------------------------------------------------ |
| Tier coverage     | a tier has no live baseline invite                           |
| Expiry defined    | a baseline invite has `expires: null`                        |
| Scope drift       | `server_names` is not exactly `[SHARE_SERVER]`               |
| Downloads         | `allow_downloads` disagrees with `TIER_DOWNLOADS[tier]`      |
| Rotation liveness | newest baseline for a tier is older than 24h (the loop died) |
| Strays            | an unlimited invite absent from `baseline_invites`           |

**Scope is verified via `server_names`, never `specific_libraries`.** Wizarr's
invitation serializer reports `specific_libraries: []` even when an invite is
correctly scoped, so that field cannot distinguish a correct invite from an
unscoped one. Confirmed against the live API on 2026-08-11 and already noted at
`e2e-tiers.mjs:140`.

## Error handling

- **Broken tier scope.** `tiers.tier_scope_problems()` runs before any mint. A tier
  that resolves to nothing is skipped with an alarm and its existing invite is left
  in place, so a Plex library rename can never empty the baseline set.
- **Wizarr unreachable.** Log and retry on the next cycle. Because reaping follows
  minting, a mid-run failure never leaves zero baselines.
- **Partial mint.** Each tier is independent; one tier failing does not abort the
  others.

## Testing

`apps/stripe-bridge/tests/test_baseline.py`, using the `responses` fakes the existing
`test_wizarr.py` and `test_bridge.py` already use. Coverage:

- mints one invite per tier with the scope `resolve_tier_access` returns
- never deletes a code absent from `baseline_invites`
- never deletes a baseline whose expiry is still in the future
- skips a tier whose scope is broken, leaving its existing invite
- audit flags each failure class above

## Configuration

| Variable                | Default | Meaning                                   |
| ----------------------- | ------- | ----------------------------------------- |
| `BASELINE_ROTATE_HOUR`  | `3`     | local hour the rotation fires             |
| `BASELINE_EXPIRES_DAYS` | `2`     | how long a baseline link stays redeemable |

`BASELINE_EXPIRES_DAYS` must stay above 1. At 1 the two generations stop
overlapping and a link shared shortly before the rotation dies almost immediately.

`store.record_baseline_invite` takes `created_at` from the rotation's clock rather
than reading the wall clock itself, so `created_at` and `expires_at` always come from
the same instant — the audit measures rotation liveness as the gap between them, and
two clocks would make that gap meaningless.

## Deploy

This changes the bridge, so it reaches production only via `bun run deploy:nas`,
confirmed with `GET /version`. Netlify does not carry it.
