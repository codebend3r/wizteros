---
name: wizteros-deploy
description: Use when deploying wizteros, releasing a version, pushing code to the Synology NAS, restarting the bridge or Wizarr containers, or publishing the SPA. Triggers include "deploy to the NAS", "cut a release", "ship this", "restart the bridge", "push to prod", "bump the version". Covers the release script, the rsync exclusions that protect live state, and the manual SSH step.
---

# Deploying wizteros

## Overview

Three deploy targets with different mechanics: the SPA (Netlify, automatic on push), the stack (NAS, manual two-step), and versioning (a script that must run on a clean tree). The dangerous part is the NAS sync, which writes into a directory holding live member data.

**The stack serves paying members. A bad sync takes down a paid service.**

## The three targets

| Target | Trigger | Mechanism |
|---|---|---|
| SPA | push to `main` | Netlify builds `web/` per `netlify.toml` (`bun run build`, publish `dist`) |
| Stack (Wizarr, Tautulli, bridge) | manual | `bun run deploy:nas`, then SSH and `docker compose up -d --build` |
| Version | manual | `bun run release:{patch,minor,major}` |

## Releasing a version

```bash
bun run verify                 # must pass first
bun run release:patch          # or :minor / :major
git push origin main v0.1.6    # the script prints the exact command
```

`scripts/release.sh` refuses to run on a dirty tree. It bumps the root and `web/` `package.json` in lockstep (npm skips its own git commit and tag because `.git` lives at the repo root, so the script owns the whole flow), commits as `WZ: Bump version to X.Y.Z`, and tags `vX.Y.Z`. It does not push. The version bump commit is the one exception to needing a bulleted body.

## Deploying the stack to the NAS

### Preflight

1. `bun run verify` passes.
2. The SMB share is mounted. Finder, Cmd+K, `smb://192.168.50.2`, mount the `docker` share. `deploy-nas.sh` checks the mount root and aborts with instructions if it is missing.
3. You know what changed. A bridge code change needs `--build`; a compose or docs change does not.

### Sync

```bash
bun run deploy:nas
# override the destination with: NAS_MOUNT=/Volumes/docker/wizteros bun run deploy:nas
```

### Apply, on the NAS

```bash
ssh <NAS_USER>@<NAS_IP>
cd /volume1/docker/wizteros
sudo docker compose up -d --build
sudo docker compose ps          # wizarr, tautulli, stripe-bridge all running
sudo docker compose logs -f stripe-bridge
```

Synology needs `sudo` for docker. If `docker compose` (v2) is missing, use `sudo docker-compose`.

## What must never be rsynced

`deploy-nas.sh` excludes these deliberately. **Never remove an exclusion, never add `--delete`.**

| Excluded | Why |
|---|---|
| `.env` | The NAS has its own with real `PUID`/`PGID`, service-name URLs, and live Stripe keys |
| `wizarr-data/` | The live Wizarr SQLite DB, three configured Plex servers, and the API key |
| `tautulli-config/` | Live Tautulli state and history |
| `stripe-bridge-data/` | The bridge's SQLite: customer map, member tags, notes, event log, processed events |
| `.git`, `venv`, `node_modules`, `.netlify` | Local junk |

Overwriting `stripe-bridge-data/bridge.db` loses every member tag, note, and the processed-events table, which means Stripe retries would reprocess old events.

## After a bridge deploy

The bridge boots into `_lifespan`, which starts two background loops: the expiry reconcile sweep and the members-snapshot refresher. The first `/admin/members` call after a restart pays the cold snapshot cost (Wizarr's user list alone is roughly 15 seconds). A slow first admin page load right after deploy is expected.

Verify the webhook path still answers:

```bash
curl -s https://<node>.<tailnet>.ts.net/stripe/webhook -X POST -d '{}'
# expect the bridge's own 400 "invalid signature", NOT a 404
```

A 404 means Tailscale Funnel lost its mount points. Re-run the Phase 3 commands in `docs/tailscale-funnel.md`.

## Live keys

The stack has run on **live** Stripe keys since 2026-07-22. The API key, the webhook signing secret, and the payment links must all come from the same environment. Never mix live and test. For a rehearsal, swap the whole set to test mode together.

## Rollback

- **SPA:** redeploy the previous build from the Netlify dashboard.
- **Stack:** the NAS copy is independent of the old Mac-side Wizarr, so nothing is destroyed by a bad deploy. Re-sync from a known-good commit and `up -d --build` again.
- **Data:** there is no automatic backup of `stripe-bridge-data/`. Copy it off the NAS before any operation that could touch it.

## Red Flags: STOP

- Deploying without `bun run verify` passing
- Adding `--delete` or removing an exclusion from `deploy-nas.sh`
- Running `release.sh` on a dirty tree, or hand-editing versions instead
- Pushing to `main` without the user asking
- Mixing live Stripe keys with test payment links

## Reference

`docs/nas-deployment.md` (full NAS runbook), `docs/tailscale-funnel.md` (public ingress), `docs/invite-flow.md` (what a deploy affects behaviourally).
