---
name: stack-health
description: Use when asked whether the wizteros production stack is working, without deploying anything. Triggers include "is the stack healthy", "are webhooks failing", "is everything up", "why did no invite go out", "morning check", "is the bridge alive", "did Stripe stop reaching us", or any report that a paying member never received an invite. Only applies to the wizteros repo.
---

# Stack health for wizteros

## Overview

A strictly read-only probe of the whole paid-access path, end to end:

```
Stripe -> Tailscale Funnel -> stripe-bridge -> Wizarr -> Plex
```

It answers "is everything working" **without running a deploy**. The checks are the
verification phase of the `deploy-nas` skill, pulled out so you can ask the question at
any time instead of only after shipping.

**It changes nothing.** Every NAS call is an `inspect`, a `compose ps`, a `cat`, a `df`
or a `docker logs` read. The only write anywhere is `git fetch` updating this clone's
remote-tracking refs in check 5. There are no mutating flags, and there is deliberately
no way to make this script deploy, restart, rebuild or edit anything. Fixing is a
different skill's job (see Where to go next).

## Running It

```bash
.claude/skills/stack-health/scripts/stack-health.sh
```

The script resolves the repo root from its own location, so it works from any clone or
worktree with no path editing. Run it as a single Bash invocation so the user sees the
whole transcript. It is safe to run at any time, on any branch, with a dirty tree.

| Flag | Meaning |
|---|---|
| `--quick` | Skip check 4 (public ingress) and check 8 (env drift). The two checks that reach off the LAN or need a local `.env`. |

Nothing else is accepted. An unrecognized flag exits 2 rather than guessing.

Useful overrides, all `WZ_*` env vars matching `deploy-nas.sh`: `WZ_NAS_HOST`,
`WZ_NAS_IP`, `WZ_PUBLIC_BASE` (when there is no local `.env`), `WZ_DISK_WARN`,
`WZ_LOG_LINES`, `WZ_REPO`.

## The Checks

| # | Check | Reads |
|---|---|---|
| 1 | NAS reachable over SSH | `ssh crivas@192.168.50.2 true` |
| 2 | Bridge container `running`, `GET :8000/admin/members` returns `401` | `docker inspect`, curl from this machine |
| 3 | Westeroz `compose ps`, wizarr + tautulli `running`, Wizarr answers on `:5690` | `compose ps` in `/volume1/docker/westeroz`, `docker inspect`, curl |
| 4 | Funnel reachable, `POST <base>/stripe/webhook` returns a 4xx | curl to `PUBLIC_INVITE_BASE` |
| 5 | `.deployed-sha` vs `origin/main` | `cat`, `git fetch`, `git rev-list` |
| 6 | Recent bridge logs: tier-scope alarm and Python tracebacks | `docker logs --tail 200` |
| 7 | `/volume1` disk usage | `df -Pk` |
| 8 | Key names in `.env.example` vs the NAS `.env` | `cat`, key names only |

Exit `0` when every check passed, `1` when any check failed. **Warnings do not fail the
run** and never change the exit code: a warning means "working, but worth knowing" (the
NAS is a few commits behind, the volume is filling up). A probe that exits nonzero for
those cannot be trusted to mean anything.

## What Each Failure Means

Translate to what the member experiences, not to what the container is doing.

- **1 fails** (no SSH) → the NAS is down, you are off the LAN, or your key is not loaded.
  Checks 2 and 3 still probe over HTTP, so read those before assuming the stack is down;
  a NAS that answers on `:8000` but not on SSH is a very different problem from a dark NAS.
- **2 fails** → the bridge is not answering. Stripe webhooks are being dropped right now.
  Every payment landing during this window creates a paying member with no invite.
- **3 fails** → wizarr or tautulli is not running. The bridge may accept webhooks, but it
  cannot create or redeem invites, so members pay and get nothing.
- **4 fails** → Stripe cannot reach us at all. A `404` on the webhook route means the
  Funnel mount is wrong (see `docs/tailscale-funnel.md`); a timeout means the Funnel is
  not carrying traffic. Either way, deliveries are failing silently.
- **5 warns "behind by N"** → not an outage. The NAS is running older code; the fix is a
  deploy, not a restart.
- **6 fails** (tier-scope alarm) → signups for the named tier are broken. See Red Flags.
- **6 warns** (tracebacks) → read the excerpt before escalating. One bad webhook payload
  is not the same as a broken bridge.
- **7 warns** → `/volume1` is filling. A full volume stops the bridge writing `bridge.db`,
  which silently loses the Stripe-to-Wizarr mapping for new members.
- **8 fails** (key missing on the NAS) → the bridge is running without config the app
  expects. Correlate with whatever else is failing; a missing `SMTP_*` explains an invite
  that was created but never emailed.
- **8 warns** (key only on the NAS) → usually fine. `TUNNEL_TOKEN` and similar NAS-only
  values legitimately live outside `.env.example`; it means the example is stale, not
  that production is wrong.

`401` on `/admin/members` is the liveness probe, not `200`. There is no `/health` route;
`401` proves FastAPI mounted the router and auth is wired, which a bare port check or a
`404` would not. Wizarr redirects unauthenticated callers, so `302` on `:5690` is healthy.

## Where To Go Next

Report the diagnosis, then name the skill. Do not start fixing from inside this one.

| Finding | Next skill |
|---|---|
| NAS behind `origin/main` (check 5) | `deploy-nas` |
| One member paid and has no access | `member-triage` |
| Stripe and Wizarr disagree about who is active | `stripe-reconcile` |
| Everything green but a member still complains | `member-triage` first, then `stripe-reconcile` |

## Reporting Back

Lead with the verdict in one line: healthy, or the specific thing that is broken and what
it costs members right now. Then the failures and warnings, then the next skill by name.

An all-green run still deserves the summary block; "everything is up" with no evidence is
what the probe exists to replace.

## Red Flags

- **A tier-scope alarm is not cosmetic.** It means a Plex library was renamed and that
  tier no longer resolves, so signups for it create wrongly scoped invites. The build is
  fine; the data drifted. Deploying will not fix it. Line the Plex and Wizarr library
  names back up.
- **A Funnel failure means Stripe webhooks are silently dying.** Nothing on the NAS looks
  wrong, because nothing is arriving. Open the Stripe dashboard's webhook attempts and
  check for failed deliveries. Stripe retries for a while, so a fast fix can still be
  clean; a slow one leaves paid members stranded.
- **Do not "fix" a failing check by rerunning until it passes.** Both the bridge probe and
  the Funnel probe are single-shot on purpose.
- **Never add a mutating flag to this script.** Its value is that it is safe to run
  reflexively, and that only holds while it cannot change anything.
- **Green checks do not prove a specific member is fine.** This probe reads
  infrastructure, not the member's row. Use `member-triage` for one person.
