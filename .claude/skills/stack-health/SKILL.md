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
| `-h`, `--help` | Print usage and exit 0. |

Nothing else is accepted. An unrecognized flag exits 2 rather than guessing, and the
error names the reason: there are no mutating flags to guess at.

`--quick` costs you the ingress check, which is the only one that asks whether Stripe can
reach us at all. Prefer a full run when the question is "did webhooks stop arriving".

Useful overrides, all `WZ_*` env vars matching `deploy-nas.sh`: `WZ_NAS_HOST`,
`WZ_NAS_IP`, `WZ_PUBLIC_BASE` (when there is no local `.env`), `WZ_DISK_WARN`,
`WZ_LOG_LINES`, `WZ_REPO`.

## The Checks

| # | Check | Reads |
|---|---|---|
| 1 | NAS reachable over SSH | `ssh crivas@192.168.50.2 true` |
| 2 | Bridge container `running`, `GET :8000/admin/members` returns `401` | `docker inspect`, curl from this machine |
| 3 | Westeroz `compose ps`, wizarr + tautulli `running`, Wizarr answers on `:5690` | `compose ps` in `/volume1/docker/westeroz`, `docker inspect`, curl |
| 4 | Funnel reachable, `POST <base>/stripe/webhook` returns exactly `400` | curl to `PUBLIC_INVITE_BASE` |
| 5 | `.deployed-sha` vs `origin/main`, including divergence | `cat`, `git fetch`, `git rev-list`, `git merge-base` |
| 6 | Recent bridge logs: tier-scope alarm and Python tracebacks | `docker logs --tail 200` |
| 7 | `/volume1` disk usage | `df -Pk` |
| 8 | Key names in `.env.example` vs the NAS `.env` | `cat`, key names only |

Exit `0` when every check passed, `1` when any check failed. **Warnings do not fail the
run** and never change the exit code: a warning means "working, but worth knowing" (the
NAS is a few commits behind, the volume is filling up). A probe that exits nonzero for
those cannot be trusted to mean anything.

**A skipped check is not a pass.** Skips also leave the exit code at 0, so read the
summary, not the exit code: a run that skipped check 4 has not established that Stripe can
reach us, and the closing line says "NOT PROBED" instead of "all checks passed". Never
relay such a run as healthy. Check 4 skips when there is no local `.env` and no
`WZ_PUBLIC_BASE`, which is the normal state of a fresh clone or worktree.

## What Each Failure Means

Translate to what the member experiences, not to what the container is doing.

- **1 fails** (no SSH) → the NAS is down, you are off the LAN, or your key is not loaded.
  Checks 2 and 3 still probe over HTTP, so read those before assuming the stack is down;
  a NAS that answers on `:8000` but not on SSH is a very different problem from a dark NAS.
- **2 fails** → the bridge is not answering. Stripe webhooks are being dropped right now.
  Every payment landing during this window creates a paying member with no invite.
- **3 fails** → wizarr or tautulli is not running. The bridge may accept webhooks, but it
  cannot create or redeem invites, so members pay and get nothing.
- **4 fails** → Stripe cannot reach us at all, and deliveries are failing silently. Read
  the status code, because they mean different things. A `404` means the `/stripe` mount is
  not reaching the bridge, so the request fell through to Wizarr at the Funnel root (see
  `docs/tailscale-funnel.md`); a `405` means something other than the bridge's POST handler
  answered; `000` means the Funnel is not carrying traffic at all.
- **5 warns "behind by N"** → not an outage. The NAS is running older code; the fix is a
  deploy, not a restart.
- **5 warns "DIVERGED" or "UNRELATED history"** → the marker on the NAS is not an ancestor
  of `origin/main`, so `main` was rewritten (rebase, force push, tag surgery) after that
  deploy. "UNRELATED" is the stronger form: the histories share no commit at all, so the
  root was rewritten and the two commit counts are just each graph's full length. In both
  cases read the "NAS-built files differing" note, not the commit counts, because most of
  the difference is the same work under new SHAs. The next `deploy-nas` run resyncs the
  marker.
- **6 fails** (tier-scope alarm) → signups for the named tier are broken. See Red Flags.
- **6 warns** ("could not run") → the check could not reach Wizarr on a recent sweep, so
  drift is unverified rather than present. The bridge treats an unreachable Wizarr as
  healthy and retries, so this is not the alarm; correlate with check 3.
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

On the webhook probe the healthy answer is **exactly `400`**, not "some 4xx". The handler
verifies the Stripe signature before touching Wizarr or the store and raises
`HTTPException(400, "invalid signature")`, so only the bridge itself produces a `400`
there. That specificity is the whole check: Wizarr is mounted at the Funnel root, so a
broken `/stripe` mount does not time out, it falls through to Wizarr, which answers `404`.
Accepting any 4xx would report that exact failure as a healthy mount.

## Where To Go Next

Report the diagnosis, then hand off. Do not start fixing from inside this one.

| Finding | Next step |
|---|---|
| NAS behind or diverged from `origin/main` (check 5) | the `deploy-nas` skill |
| Funnel or webhook route failing (check 4) | `docs/tailscale-funnel.md` to re-check the mounts, then Stripe's webhook-attempts log for failed deliveries |
| Tier-scope alarm (check 6) | line the Plex and Wizarr library names back up; once they match, `bun run refresh:libraries` re-records the list the tier tests assert against |
| Bridge down (check 2) or wizarr/tautulli down (check 3) | read `docker logs` on the NAS for the reason before restarting anything |
| One member paid and has no access, everything else green | not this skill: this probe reads infrastructure, not a member's row. Check that member in the admin portal's member list and against Stripe's dashboard |

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
  infrastructure, not the member's row. For one person, go to that member's record in the
  admin portal and their subscription in Stripe.
- **Do not relay a skipped check as a pass.** A run with no local `.env`, and every
  `--quick` run, leaves the ingress check unprobed while still exiting 0. Say which checks
  did not run.
