---
name: stripe-reconcile
description: Use when checking whether Stripe, the stripe-bridge store, and Wizarr still agree about who is paying and who has access, on a routine sweep or after a Tailscale Funnel or bridge outage. Triggers include "reconcile stripe with wizarr", "who is paying but not invited", "audit member drift", "did we miss any webhooks", "is anyone still watching for free", "check for lapsed members", or a gap in Stripe's webhook delivery log. Only applies to the wizteros repo.
---

# Reconcile Stripe, the bridge store, and Wizarr

## Overview

The bridge is webhook-driven and fire-and-forget. A delivery that never lands (Funnel
down, container restarting, a Stripe retry that ran out) silently desyncs the three
systems, and nothing else in the repo ever notices: Stripe keeps charging, the store
keeps its old flags, Wizarr keeps whatever access it had. This skill audits that drift.

**Strictly read-only.** No Stripe writes, no Wizarr writes, no store writes, no container
commands on the NAS. It reports; a human fixes. The only NAS access is a tar read of the
bridge's data directory into a temp copy that is deleted before the process exits.

## When To Run

- **Weekly sweep**, or before any release that touches the payment path.
- **After a Funnel or bridge outage**, once the container is healthy again. Cross-check
  the same window in Stripe's webhook delivery log; this finds what the retries missed.
- **After a `deploy-nas` rollback**, or any stretch where the bridge was down.
- **On a specific complaint**: a member says they paid and have no access, or someone who
  canceled months ago is still streaming.

Wait for Stripe's own retries before running. Stripe retries a failed webhook for up to
three days, so a sweep during (or right after) an outage reports drift that would have
healed itself.

## Running It

```bash
node --env-file-if-exists=.env .claude/skills/stripe-reconcile/scripts/reconcile.mjs
```

Run it from the repo root as a single Bash invocation so the user sees the whole
transcript. Needs the LAN (Wizarr on `192.168.50.2:5690`, the NAS over SSH) and a live
`STRIPE_API_KEY`. The Wizarr sweep alone takes ~15s, so expect the run to sit for a while.

Use `--env-file-if-exists`, not `--env-file`. With plain `--env-file` a clone that has no
`.env` (a fresh worktree, say) dies as `node: .env: not found` with exit **9**, before the
script can run and report the real problem. The `if-exists` form lets the script's own
guard fire and exit `2` with the list of variables it actually wants.

| Flag | Meaning |
|---|---|
| `--no-store` | Skip the NAS copy and compare Stripe against Wizarr only. Use it off-LAN |
| `--all` | Print every note line instead of the first 12 |

Exit codes: `0` clean, `1` drift found, `2` misconfigured, or Stripe/Wizarr unreadable.
An unreadable **store** is deliberately not `2`: the run degrades to a two-way comparison
and still exits `0`/`1`, so read the `sources` block, never just the exit code.

`WZ_NAS_HOST` and `WZ_NAS_PATH` override the NAS target, the same names the `deploy-nas`
**skill** script uses. (The older `scripts/deploy-nas.sh` at the repo root is a different
thing and keys off `NAS_MOUNT`.)

## What It Reads

1. **Stripe** `GET /v1/subscriptions?status=all`, paginated, customer expanded inline.
   `active` and `trialing` count as paying; every other status (canceled, past_due,
   unpaid, incomplete, paused) counts as lapsed. Customer ids the store knows but the
   sweep never saw get an individual `GET /v1/customers/<id>` to prove they still exist.
2. **Wizarr** `GET /api/users`, collapsed to one entry per person keyed on lowercased
   email falling back to username, the way `admin._dedupe_members` does for
   `/admin/members`, plus `GET /api/invitations` so a member whose Plex email differs
   from their Stripe email is matched through their invite code instead of being reported
   twice. That hop needs the store, which is where the invite code lives; `/api/invitations`
   only maps a code to the Plex username that redeemed it.
   One deliberate divergence from `_dedupe_members`: on expiry this keeps `null`
   (unlimited) as the winner, where the admin table keeps the latest non-null date. The
   admin table is displaying a date; this is deciding whether the person can watch, and
   one unlimited record means they can.
3. **The store** `bridge.db` tarred out of `/volume1/docker/stripe-bridge/stripe-bridge-data`
   over one-shot SSH and read with `sqlite3 -readonly`, into a temp copy deleted in a
   `finally` before the process exits. Columns come from `PRAGMA table_info`, because
   `tier`, `invited_at` and `subscribed` were all added by migrations (`store._ensure_*`)
   and an older prod DB legitimately lacks them.

No store (NAS off the LAN, no `sqlite3` locally, `--no-store`) degrades to a two-way
Stripe vs Wizarr comparison. The run says so in its header and again in the summary, and
the checks that need the store (VIP tags, ghost customers, store flags) are skipped, not
silently passed. **Degraded runs also lose the invite-code hop**, so any member whose Plex
email differs from their Stripe email is reported twice: once as `PAYING-NO-ACCESS` and
once as `legacy`. Treat a degraded run as a smoke test, not an audit.

## Reading The Report

One line per person, grouped by kind.

| Line | What it means | First move |
|---|---|---|
| `PAYING-NO-ACCESS` | Contributing right now, but their Wizarr record is missing, disabled, or expired | Reissue the invite from the admin UI, or reset the expiry if the record is just stale |
| `ACCESS-NO-PAYING` | Still enabled in Wizarr with nothing paying for it, past the `ACCESS_DURATION` window they last paid for | A judgment call, not a cleanup task. See Red Flags |
| `GHOST-CUSTOMER` | A `customer_map` row points at a `cus_...` that Stripe says is deleted or missing | Read-only curiosity unless the member is also listed above; the row is stale bookkeeping |
| `STORE-FLAG` | Stripe and the store disagree about whether the member is subscribed | The fingerprint of a missed webhook. Confirm against the member's Stripe subscription |

The **notes** section is expected states, never drift, and never counted:

- `pending` a paying member with an invite still inside the `INVITE_EXPIRES_DAYS` grace
  window (14 days unless `.env` says otherwise; the header line prints the value in force)
- `winding` no longer paying, but still inside the paid-through window: a cancel dated by
  `ended_at`, or a `past_due`/`unpaid` sub still inside the period it last billed for
- `vip` tagged VIP, so intentionally has access with no subscription
- `legacy` enabled in Wizarr with no Stripe presence at all (a manual or pre-Stripe share)

A person with two problems gets one line: the store mismatch is folded into their finding
as the diagnosis rather than repeated.

## Remedies

Every fix is manual and lives elsewhere:

- **The admin web UI** is the whole remedy surface. `/user` for one member (Invite /
  Re-invite, reset expiry, reset tier, cancel subscription, VIP tag), `/manage` for the
  list. Those routes call `/admin/*`, which needs a Supabase session, which is why this
  script cannot and does not touch them.
- **`member-triage`** owns deciding what to do about one named member. This skill answers
  "who is out of sync"; that one answers "and what should happen to them".
- Never add a write path to `reconcile.mjs`. Its value is that it is safe to run at any
  time, on live data, without thinking about it first.

## Reporting Back

Lead with the counts, then name names. State plainly whether the store was readable, and
if it was not, which checks did not run. Point at the likely cause when the shape fits:
a cluster of `STORE-FLAG` lines with adjacent dates is a webhook outage, one lonely
`PAYING-NO-ACCESS` is usually one member who never redeemed.

Say explicitly that nothing was changed. An exit code of `1` means drift was found, not
that the script failed.

## Red Flags

- **Never auto-fix drift.** Not from this script, not by hand-following it with a batch of
  admin calls. Every line is a person, and several of the categories are legitimate.
- **A lapsed-but-still-enabled member is a human decision.** Family, a friend between
  jobs, someone who contributes another way. Present the line, propose nothing, and never
  revoke access on the strength of a report.
- **Stripe-but-no-Wizarr is often just an unredeemed invite.** The script already parks
  those in `pending` while the grace window runs, but a member who took six weeks to click
  the link is still a normal member. Check their history before calling it a failure.
- **VIPs have no subscription by design.** In degraded mode (no store) the VIP tag is
  invisible, so every VIP shows up as `legacy` or worse, and the invite-code hop is gone
  too, so mismatched-email members are double-reported. Do not act on a degraded run.
- **An unreadable store still exits `0` or `1`.** Read the `sources` block before you
  trust a clean answer; the exit code alone cannot tell "all three agree" from "two of
  them agree and the third never answered".
- **Wizarr may not expose an enabled flag on `/api/users`.** The run prints a caveat line
  when it does not. A canceled member's record is disabled but keeps its old expiry, so
  without that flag they can still read as having access. Confirm in the admin UI.
- **Running mid-outage** reports queued-but-not-yet-delivered events as drift. Let the
  retries land first.
- **A "clean" run is not proof the bridge works.** It only proves the three systems agree
  right now. The e2e scripts (`bun run test:e2e`, `test:e2e:tiers`) prove the flow.
