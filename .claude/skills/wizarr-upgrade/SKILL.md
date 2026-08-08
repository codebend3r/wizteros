---
name: wizarr-upgrade
description: Use when upgrading, updating, or rolling back the Wizarr container in the NAS-side westeroz project, or judging whether a newly released Wizarr version is safe to take. Triggers include "upgrade wizarr", "update the wizarr container", "is a new wizarr version safe", "wizarr upgrade broke invites", "roll back wizarr", "upgrade tautulli", or a Container Manager update prompt for the wizarr image. Only applies to the wizteros repo.
---

# Upgrading Wizarr on the NAS

## Overview

Wizarr is the scariest external dependency in this stack. It owns the invites, it owns
the healed library-name cache that makes redemption work, and its database migrates
**forward only**. A bad upgrade does not just break a page; it can leave a database the
previous image refuses to open, with no way back except a backup taken beforehand.

This runbook upgrades the `wizarr` service in the NAS-side `westeroz` compose project.
Tautulli is a footnote at the bottom: same shape, far lower stakes.

**Everything happens over SSH.** The `westeroz` compose file is NAS-side only
(`/volume1/docker/westeroz/docker-compose.yml`); it is not in this repo and must never
be recreated from it. This repo's root `docker-compose.yml` defines the `stripe-bridge`
project only.

Constants used throughout:

| Thing | Value |
|---|---|
| SSH target | `crivas@192.168.50.2` |
| Compose project dir | `/volume1/docker/westeroz` |
| Docker binary | `sudo -n /usr/local/bin/docker` (literal path, see Hard-Won Details) |
| Wizarr URL | `http://192.168.50.2:5690` |
| Bridge URL | `http://192.168.50.2:8000` (separate project, `/volume1/docker/stripe-bridge`) |

Work through the steps in order. Do not reorder, and do not start at step 4 because the
upgrade "looks routine".

---

## 1. Discover, never assume

Read the live service definition before touching anything. The image reference is not in
this repo and nobody remembers it correctly.

```bash
ssh crivas@192.168.50.2 'cat /volume1/docker/westeroz/docker-compose.yml'
```

From the `wizarr:` block, write down:

- the exact `image:` reference,
- whether it is **pinned** (`...:2.4.1`) or **floating** (`...:latest`),
- every `volumes:` line (confirm `wizarr-data` is the state directory),
- the published port (expected `5690`).

Then record the rollback coordinates from the *running container*, which is the only
place the currently-deployed bytes are identified:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker inspect --format "{{.Config.Image}}  {{.Image}}" wizarr'
```

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker image inspect --format "{{json .RepoDigests}}" $(sudo -n /usr/local/bin/docker inspect --format "{{.Image}}" wizarr)'
```

The first prints the configured reference and the image id. The second prints the
digest-pinned reference (`registry/wizarrrr/wizarr@sha256:...`). **The digest is the
rollback target.** A tag is not: with `:latest`, the tag has already moved by the time
you want to go back.

Paste both into your notes now. If you skip this and the upgrade goes wrong, there is no
way to name the old image.

## 2. Preflight: prove the stack is healthy first

Never upgrade on top of an unknown baseline. If something is already broken, you will
not be able to tell afterwards whether the upgrade caused it.

Use the **stack-health** skill. If it is unavailable, the manual probes are:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker inspect --format "{{.Name}} {{.State.Status}}" wizarr tautulli stripe-bridge'
```

```bash
ssh crivas@192.168.50.2 'curl -s -L -o /dev/null -m 10 -w "wizarr %{http_code}\n" http://192.168.50.2:5690/'
```

```bash
ssh crivas@192.168.50.2 'curl -s -o /dev/null -m 10 -w "bridge %{http_code}\n" http://192.168.50.2:8000/admin/members'
```

Expected: all three containers `running`, Wizarr answers `200` (following its redirect to
login or setup), bridge answers `401`. The bridge has no `/health` route; `401` from the
admin router is the liveness probe, and `200` there would mean auth is *not* wired.

Also read the tier-scope state before you change anything (step 5 compares against it):

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker logs --since 2h stripe-bridge 2>&1 | grep -i "tier scope check" || echo "no tier scope alarms in the last 2h"'
```

If the alarm is already firing, **stop**. Fix the drift first. See Red Flags.

## 3. Back up. This step is never skipped

Use the **nas-state-backup** skill. Its job is `wizarr-data` (the Wizarr database plus
the healed library-name cache); `tautulli-config` and the bridge's `stripe-bridge-data`
come along for free and are cheap insurance.

**Why this is mandatory and not a nicety:** a Wizarr upgrade may migrate its database on
first boot, and the migration is one-way. There is no downgrade path in Wizarr. Once a
newer schema is written into `wizarr-data`, the previous image can no longer open it, so
re-pointing the compose file at the old digest fixes nothing. The step 3 backup is the
only road back, and it has to exist *before* the new image starts.

If nas-state-backup is unavailable, this is the minimum acceptable substitute. It stops
Wizarr so SQLite is not copied mid-write, and it tars through a throwaway container
because `docker` is the only binary available under non-interactive `sudo`:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose stop wizarr && sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/westeroz/wizarr-data:/src:ro -v /volume1/docker/westeroz:/out alpine tar -czf /out/wizarr-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /src . && sudo -n /usr/local/bin/docker compose start wizarr'
```

Then prove the archive exists and is not zero bytes:

```bash
ssh crivas@192.168.50.2 'ls -lh /volume1/docker/westeroz/wizarr-data-*.tar.gz | tail -3'
```

Record the archive path. You will name it in the report, and you will need it in step 6.

## 4. Pull and recreate only the wizarr service

Two commands, both naming `wizarr` explicitly.

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose pull wizarr'
```

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose up -d wizarr'
```

The service name is load-bearing. `westeroz` holds wizarr, tautulli, and the media
services; a bare `compose pull` or `compose up -d` sweeps all of them, turning a scoped
Wizarr upgrade into an unplanned upgrade of the whole stack.

If `pull` reports the image is already up to date and no new layers arrive, there is
nothing to upgrade. Stop here and say so.

## 5. Verify, in escalating depth

Each level catches something the level above it cannot. Run them in order and stop at
the first failure.

**5a. The container is running on the new image.**

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker inspect --format "{{.State.Status}}  {{.Image}}" wizarr'
```

`running`, and an image id different from the one recorded in step 1. A container that
comes up and exits seconds later reads as `running` on a fast check, so if in doubt
re-run this after a minute and confirm `{{.RestartCount}}` is not climbing.

**5b. The web UI answers.**

```bash
ssh crivas@192.168.50.2 'curl -s -L -o /dev/null -m 15 -w "%{http_code}\n" http://192.168.50.2:5690/'
```

Expect `200`. This proves the process booted and migrations (if any) completed; a Wizarr
still migrating or crash-looping will time out or return `502`.

**5c. The bridge's API key still works.** An upgrade can invalidate keys or change auth
handling, and nothing in the UI would tell you. Probe the exact endpoint
`WizarrClient.list_libraries()` calls (`GET /api/libraries` with an `X-API-Key` header,
see `stripe-bridge/stripe_bridge/wizarr.py`), using the key the bridge itself holds:

```bash
ssh crivas@192.168.50.2 'KEY=$(sudo -n /usr/local/bin/docker exec stripe-bridge printenv WIZARR_API_KEY); curl -s -o /dev/null -m 20 -w "%{http_code}\n" -H "X-API-Key: $KEY" http://192.168.50.2:5690/api/libraries'
```

`200` means the key survived. `401` or `403` means the upgrade invalidated it, and every
signup is broken until a new key is generated in Wizarr settings and written to
`/volume1/docker/stripe-bridge/.env` (followed by a bridge restart). To eyeball the
library names too, swap the `-o /dev/null -w` flags for `| head -c 300`.

Use `/api/libraries`, not `/api/users`: the users endpoint reconciles against every Plex
server on each call and routinely takes 15 seconds or more, so it makes a terrible probe.

**5d. Invites still work end to end.** This is the level that matters, and the only one
that exercises creation, scoping, and the healed library cache together. Use the
**e2e-runner** skill, which drives `bun run test:e2e:tiers` from the repo root. That
script pushes a signed synthetic checkout through the bridge for each of
bronze/silver/gold/youth, reads back the invite Wizarr created, asserts the exact library
scope, and deletes the invite afterwards. It uses an `@invalid.test` email that matches
no Plex account, so no real member is ever touched.

Two things to get right: the run must point at whichever bridge you mean
(`BRIDGE_URL=http://192.168.50.2:8000` for the NAS one; it defaults to `localhost:8000`),
and the local `STRIPE_WEBHOOK_SECRET` must be the one that bridge verifies against, or
every webhook is rejected before it reaches Wizarr. Running this in step 2 as well gives
a clean before/after comparison and is worth the extra minute.

A pass here is the real green light. Anything else, go to step 6.

**5e. Fresh bridge logs show no tier-scope alarm.** The alarm means the Plex library
names and the Wizarr library names stopped lining up, which an upgrade can cause on its
own if Wizarr renames or re-heals libraries. The check runs on the bridge's reconcile
loop and once at boot, so restart the bridge to force a fresh one:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/stripe-bridge && sudo -n /usr/local/bin/docker compose restart stripe-bridge'
```

Wait about 25 seconds for the boot check to call Wizarr, then read the result:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker logs --since 5m stripe-bridge 2>&1 | grep -i "tier scope check" || echo "tier scope check: no alarms"'
```

Restarting the bridge is safe: Stripe retries webhooks, and the SQLite mapping is on a
bind mount. A `tier scope check: <tier> -> <reason>` line means members cannot sign up
for that tier until the names line up again, even though the upgrade itself "worked".

## 6. Rollback

First decide which rollback you need. They are not the same size.

**Did the new version migrate the database?**

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker logs wizarr 2>&1 | grep -iE "alembic|running upgrade|migrat|schema" | head -30'
```

Cross-check the release notes for every version between the old tag and the new one
(github.com/wizarrrr/wizarr releases) for the words migration, schema, or breaking.

- **No migration lines and no migration in the release notes**: the database on disk is
  untouched, so a **plain image rollback is enough**. The old image opens the same file
  it wrote.
- **Any `Running upgrade <rev> -> <rev>` line, alembic output, or a release note naming a
  migration**: the database moved forward and cannot move back. The image rollback alone
  will fail, usually as a crash loop or an unknown-column error. You must **also restore
  `wizarr-data`** from the step 3 backup.
- **Cannot tell**: treat it as migrated. Restoring a good backup over an unmigrated
  database costs you nothing; skipping a needed restore costs you the invite system.

**Plain image rollback** (re-point the service at the digest recorded in step 1):

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && cp docker-compose.yml docker-compose.yml.pre-rollback'
```

Edit the single `image:` line in the `wizarr:` block to the recorded digest, then confirm
you changed the right line and only that line:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && grep -n "image:" docker-compose.yml'
```

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose up -d wizarr'
```

Prefer the digest over the previous tag. With a floating tag the old bytes are no longer
reachable by name, and even a pinned tag can be re-pushed upstream. If you only have the
previous tag, use it, and say so in the report.

**Image rollback plus state restore** (the migrated case). Move the migrated directory
aside rather than deleting it, so a bad restore is still recoverable:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose stop wizarr && mv wizarr-data wizarr-data.migrated-$(date +%Y%m%d-%H%M%S)'
```

Restore `wizarr-data` from the step 3 archive (nas-state-backup owns the restore
mechanics; use them rather than improvising), re-point the image line as above, then:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose up -d wizarr'
```

After **any** rollback, re-run step 5 from 5a. The restored `wizarr-data` brings back the
healed library-name cache, and 5d plus 5e are what prove it actually came back.

## Tautulli, the easy sibling

Identical shape, one word changed:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose pull tautulli && sudo -n /usr/local/bin/docker compose up -d tautulli'
```

The stakes are far lower. Tautulli owns no invites, the bridge never calls it, and
nothing in the payment path depends on it, so the worst case is losing analytics history
rather than losing access control. Still back up `tautulli-config` (step 3 covers it),
and verify with just: container `running`, and the UI answers on `http://192.168.50.2:8181`.
Skip steps 5c through 5e entirely.

## Hard-Won Details (do not "simplify" these away)

- **`sudo` needs the literal path `/usr/local/bin/docker`.** The NOPASSWD sudoers rule
  matches that exact string. Plain `sudo docker ...` prompts for a password and fails
  non-interactively.
- **Only `docker` is available under non-interactive `sudo`.** No `sudo tar`, no
  `sudo cp`, no `sudo chown`. Anything needing root has to be done through a container,
  which is why the fallback backup in step 3 looks the way it does.
- **One-shot SSH only**: `ssh host 'cd ... && ...'`, never an interactive two-step. A bare
  local `cd /volume1/...` hits the Mac's zoxide alias and fails.
- **Name the service on every compose command.** `westeroz` is a multi-service project;
  an unscoped `pull` or `up -d` upgrades or recreates everything in it.
- **The `westeroz` compose file is NAS-side only.** It is not in this repo and there is no
  copy to diff against. Read it, back it up before editing (`docker-compose.yml.pre-*`),
  and never regenerate it from this repo's root compose file, which defines the bridge
  project alone.
- **`wizarr-data` is the crown jewels**: the Wizarr database and the healed library-name
  cache. Clobbering or losing it re-breaks invite redemption, which is exactly the failure
  the deploy-nas sync excludes it to avoid.
- **`/api/libraries` is the authenticated probe, `/api/users` is not.** The users endpoint
  reconciles with each Plex server per call (the bridge allows it 45 seconds), so it will
  look like a failure when it is merely slow.
- **Do not prune images between step 4 and a passing step 5.** `docker image prune` or a
  Container Manager cleanup deletes exactly the image you recorded as the rollback target.

## Reporting Back

State plainly:

- **From and to**: the old image reference and digest (step 1) and the new one (step 5a),
  plus whether the tag is pinned or floating. If it is floating, say so and recommend
  pinning.
- **Backup**: the archive path from step 3, or an explicit statement that nas-state-backup
  ran and where it put things. If there is no backup, there was no upgrade.
- **Verification results, one line each** for 5a through 5e: container state, web UI code,
  API key probe code, the tier e2e result (pass, or which tiers failed and how), and the
  tier-scope log result.
- **Migration status**: whether migration lines appeared in the Wizarr logs, because that
  determines what a future rollback costs.
- **If anything was rolled back**: which flavour (image only, or image plus `wizarr-data`
  restore), where the migrated `wizarr-data.migrated-*` directory was parked, and what the
  post-rollback re-verification said.

If the tier-scope alarm fired, lead with it. The container is fine; signups for the named
tiers are not, and that is invisible from the Wizarr UI.

## Red Flags

- **No backup.** Upgrading Wizarr without a verified `wizarr-data` backup is the single
  worst thing this runbook can prevent. The migration is one-way; without the backup a
  bad upgrade is permanent. STOP and take one.
- **The tier-scope alarm is already firing at preflight.** Upgrading now destroys your
  ability to attribute the breakage. Fix the name drift first, confirm a clean check, then
  upgrade.
- **`:latest` drift.** If the image is floating, a routine `compose pull` (or a Container
  Manager auto-update, or somebody pulling an unrelated service without naming it) can
  upgrade Wizarr by accident, with no backup and nobody watching. Recommend pinning to the
  digest currently running, so upgrades become a deliberate edit to that one line.
- **"The UI loads, we're done."** The Wizarr UI answering on `:5690` says nothing about
  the bridge's API key, the healed library cache, or invite scoping. Step 5d is not
  optional; skipping it is how a broken signup path ships and is discovered by a paying
  member instead of by you.
- **Bare `compose up -d` in `/volume1/docker/westeroz`.** Recreates every service in the
  project, not just wizarr.
- **Pruning or cleaning up images before step 5 passes.** Deletes the rollback target.
- **Restoring `wizarr-data` by overwriting it.** Move the migrated directory aside instead,
  so a bad restore is not a second unrecoverable step.
- **Editing the compose file from the repo.** The `westeroz` compose file only exists on
  the NAS. Edit it there, with a `.pre-rollback` copy alongside it.
