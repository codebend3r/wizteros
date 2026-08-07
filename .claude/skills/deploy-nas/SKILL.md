---
name: deploy-nas
description: Use when shipping wizteros main to the Synology NAS — deploying the stripe-bridge, rebuilding its container after a merge to main, or checking whether the NAS is behind. Triggers include "deploy to the NAS", "rebuild the bridge", "push this to the NAS", "is the NAS running the latest code", "ship main", or any follow-up to a merged PR that touched apps/stripe-bridge/. Only applies to the wizteros repo.
---

# Deploy wizteros to the NAS

## Overview

Ships the current `main` of the wizteros repo to the Synology NAS and rebuilds the
`stripe-bridge` container, then proves the result is healthy before calling it done.

This is a **production deploy** — the bridge is what converts live Stripe webhooks into
Wizarr invites. Run it deliberately, not reflexively.

**Scope: the bridge only.** `apps/admin-portal/` ships via Netlify from `main` and needs
nothing here.
The `westeroz` compose project (wizarr, tautulli, sab, radarr, sonarr) is a separate NAS
stack and is never touched.

## Running It

```bash
.claude/skills/deploy-nas/scripts/deploy-nas.sh
```

The skill lives in the repo, and the script resolves the repo root from its own
location — so it works from any clone or worktree with no path editing. Override with
`WZ_REPO=/some/other/clone` if you ever need to ship a different tree.

| Flag | Meaning |
|---|---|
| `--dry-run` | Report what would sync and rebuild; change nothing |
| `--force` | Rebuild even when the NAS is already on this SHA, or when no NAS-built path changed |
| `--skip-verify` | Skip health checks (and therefore rollback). Rarely correct |
| `--no-rollback` | Verify, but leave a bad build running instead of reverting |

Run it as a single Bash invocation so the user sees the whole transcript. Default to
`--dry-run` first when the user seems unsure whether the NAS needs anything.

## What It Does

1. **Preflight** — repo clean, on `main`, `HEAD == origin/main`, NAS reachable over SSH.
   Any failure aborts before touching the NAS.
2. **Staleness check** — reads `.deployed-sha` from the NAS and diffs it against `HEAD`.
   Exits early ("nothing to do") when the NAS is current, or when the intervening commits
   touched only `apps/admin-portal/`/`docs/`.
3. **Records a rollback point** — the image ID the running container was built from.
4. **Syncs code** — rsync over the SMB mount if `/Volumes/docker` is mounted, otherwise
   tar over SSH. Then verifies a checksum matches before rebuilding.
5. **Rebuilds** — `sudo -n /usr/local/bin/docker compose up -d --build`.
6. **Verifies** — container `running`; `GET /admin/members` returns `401`; boot logs
   scanned for the tier-scope alarm and tracebacks.
7. **Rolls back** on a failed health check, re-tagging the previous image, and restores
   the old `.deployed-sha`.

## Hard-Won Details (do not "simplify" these away)

- **`sudo` needs the literal path `/usr/local/bin/docker`.** The NOPASSWD sudoers rule
  matches that exact string. Plain `sudo docker …` prompts for a password and fails
  non-interactively, because `docker` isn't on the non-interactive `PATH`.
- **macOS `rsync` is `openrsync` and fails key auth to this NAS**, even with `-e ssh -i …`.
  That is why the no-mount path is tar over SSH, not rsync over SSH.
- **Never sync `.env`, `wizarr-data/`, `tautulli-config/`, `stripe-bridge-data/`.** They are
  live NAS state. `wizarr-data/` in particular holds Wizarr's healed library-name cache;
  clobbering it re-breaks invite redemption.
- **One-shot SSH only** — `ssh host 'cd … && …'`, never an interactive two-step. A bare
  local `cd /volume1/...` hits the Mac's zoxide alias and fails.
- **`401` is the liveness probe, not `200`.** There is no `/health` route; `/admin/members`
  returning `401` proves the router mounted and auth is wired.
- **The sync never deletes.** Both transports add and overwrite, so paths that moved in the
  repo leave a stale copy on the NAS. After the Nx move the bridge lives at
  `apps/stripe-bridge/`, and the old `/volume1/docker/stripe-bridge/stripe-bridge/` is dead
  weight that compose no longer builds from. Remove it once, by hand, after the first
  post-migration deploy verifies healthy:
  `ssh <nas> 'rm -rf /volume1/docker/stripe-bridge/stripe-bridge'`. Never touch the
  sibling `stripe-bridge-data/`, which is live state.

## Reporting Back

Summarize: the SHA deployed (and what it replaced), container state, and the tier-scope
result. If the tier alarm fired, say so prominently — the build is fine but signups for
the named tier are broken until the Plex/Wizarr library names line up.

If the run aborted, say which step failed and what state the NAS is in — specifically
whether code was synced (rebuild pending) or nothing changed at all.

## Red Flags

- Dirty tree or not on `main` → STOP. The NAS gets the working tree, not the last commit.
- `HEAD != origin/main` → STOP. Never ship a SHA that isn't on origin.
- Sync verification fails → STOP before rebuilding; the NAS may hold a partial tree.
- Health check fails → the script rolls back. Do not re-run with `--skip-verify` to force
  it through; find out why first.
- User asks to deploy a feature branch → this skill ships `main` only. Ask them first.
