---
name: arr-stack-update
description: Use when the media stack containers on the Synology docker hosts need to move to their latest images — Sonarr, Radarr, Sabnzbd, Prowlarr, Lidarr, Seerr, Audiobookshelf, Bookshelf. Triggers include "update the arr stack", "update sonarr and radarr", "pull the latest images on Meleys", "are the containers out of date", "update docker images on the NAS", "the arr apps are stale". Covers both Meleys and Vermithor. Only applies to the wizteros repo.
---

# Update the *arr stack

## Overview

Moves the media-stack containers on the two Synology docker hosts to their latest
images: pull, recreate **only what actually changed**, prove each service answers
again, and roll a service back to its previous image if it does not.

Everything in these stacks tracks a floating tag (`:latest`, or `:hardcover` for
bookshelf), so "update" means _repull the tag and recreate the container_. There is
no version to bump anywhere in this repo.

**Scope: the media stack only.** `stripe-bridge` is built from this repo rather than
pulled, and belongs to the `deploy-nas` skill. `wizarr` and `tautulli` hold live state
and are excluded by default — see Stateful Services below.

## The two stacks

Both are single compose projects, discovered at runtime from container labels — never
hardcode the paths, they have moved before.

| Host        | Project    | Directory                  | Services                                                                                 |
| ----------- | ---------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `meleys`    | `westeroz` | `/volume1/docker/westeroz` | sonarr, radarr, sabnzbd (+ wizarr, tautulli)                                             |
| `vermithor` | `essoz`    | `/volume1/docker/essoz`    | sonarr, radarr, lidarr, prowlarr, sabnzbd, seerr, audiobookshelf, bookshelf (+ tautulli) |

Both hosts run a `sonarr`, a `radarr` and a `sabnzbd`. **Always name the host** — never
say "the sonarr container".

Full inventory, ports, and volume layout: `docs/arr-stack.md`.

## Running It

```bash
.claude/skills/arr-stack-update/scripts/update-arr-stack.sh meleys
.claude/skills/arr-stack-update/scripts/update-arr-stack.sh all --check
```

| Flag                 | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `--check`            | Pull images and report which are newer; leave containers running as-is |
| `--services "a b"`   | Update only these compose services                                     |
| `--include-stateful` | Also update wizarr and tautulli — snapshot them first                  |
| `--prune`            | Delete the superseded images afterwards                                |
| `--no-rollback`      | Leave a service that fails its health check on the new image           |
| `--timeout <s>`      | Readiness wait per service, default 120                                |

Run it as one Bash invocation so the user sees the whole transcript. Reach for
`--check` first when the user is asking _whether_ anything is stale rather than telling
you to update it.

## What It Does

1. **Preflight** — SSH reachable, and works out whether that host's docker sudo needs a
   password.
2. **Discovers the stack** from `com.docker.compose.*` labels: service names, project
   directory, published ports. Filters out the stateful and non-pulled services.
3. **Records a rollback point** — the image ID each container is currently running.
4. **Pulls** the tags for the selected services.
5. **Compares** each tag's image ID before and after. Exits early when nothing moved,
   which is the common case on a stack updated last week.
6. **Recreates only the changed services** — `compose up -d <changed>`. Untouched
   services keep their uptime.
7. **Verifies** each recreated service: container `running`, then its published port
   answers over HTTP within the timeout.
8. **Rolls back** just the services that failed, by re-tagging the previous image ID and
   forcing a recreate. Healthy services are left on the new image.
9. **Reports** the version each app logged on boot.

## Stateful Services

`wizarr` and `tautulli` are in these same compose projects but excluded from the default
set, because their bind mounts are live production state — Wizarr's member DB and healed
library-name cache, Tautulli's watch history.

Before ever passing `--include-stateful`:

- **REQUIRED:** snapshot first with the `nas-state-backup` skill.
- For Wizarr specifically, prefer the `wizarr-upgrade` skill, which judges whether a
  given release is safe to take and knows the rollback shape.

`stripe-bridge` is filtered out unconditionally. It is built from this repo, `compose
pull` has nothing to fetch for it, and `deploy-nas` owns its lifecycle.

## Hard-Won Details (do not "simplify" these away)

- **`sudo` needs the literal path `/usr/local/bin/docker`.** Docker is not on the
  non-interactive `PATH`, so a plain `ssh host docker ps` returns `command not found`,
  and the socket is `root:root` so every call needs sudo.
- **The two hosts do not share a sudo setup.** Meleys has a NOPASSWD rule for that exact
  docker path; **Vermithor does not** and needs a password, read from the login keychain
  (service `synology-nas`, account = hostname) where the `nas` helper stores it. Run
  `nas setpw vermithor` once if it is missing. The passwords are per-box, not shared.
- **macOS ships bash 3.2.** The script avoids associative arrays and `mapfile` for that
  reason. Do not "modernize" it unless you also change the shebang.
- **Recreate only what changed.** `compose up -d` with no service list would restart the
  stateful containers too, and bounce services whose image never moved.
- **A 302 or a 401 is healthy.** Sonarr redirects to its login, some apps 401 unauth'd.
  Only a connection failure or a 5xx means broken.
- **Rollback is best-effort for an app that already migrated its DB.** Sonarr and Radarr
  run schema migrations on first boot of a new major; re-tagging the old image gets the
  old binary back, but it may refuse a migrated `*.db`. If a rollback container also
  fails to start, restore that service's `config/` from a snapshot — the image alone is
  not enough.
- **Superseded images are the rollback path.** They are kept unless `--prune` is passed.
  Do not prune in the same breath as an update you have not yet confirmed is good.
- **SABnzbd survives a recreate mid-download.** Queue and incomplete data live in the
  bind-mounted config and downloads dirs, and it resumes. It is still worth checking the
  queue is moving afterwards if a large download was in flight.

## Reporting Back

Summarize per service: what moved (old image age → new), the version now running, and
the health-check result. Call out explicitly anything that was **skipped** (stateful) or
**rolled back**, and say that superseded images are still on disk unless pruned.

If the user asked about only one host, do not silently update the other.

## Red Flags

- About to pass `--include-stateful` with no snapshot taken → STOP, run `nas-state-backup`.
- Reaching for this skill to ship `stripe-bridge` → wrong skill, use `deploy-nas`.
- A service fails its health check and the instinct is to rerun with `--no-rollback` to
  "get past it" → find out why first; read the container logs.
- Pruning immediately after an update nobody has verified → the rollback path is gone.
- Hardcoding `/volume1/docker/westeroz` into anything new → discover it from the labels.
