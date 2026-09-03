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

| Thing               | Value                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| SSH target          | `crivas@192.168.50.2`                                                          |
| Compose project dir | `/volume1/docker/westeroz`                                                     |
| Docker binary       | `sudo -n /usr/local/bin/docker` (literal path, see Hard-Won Details)           |
| Wizarr URL          | `http://192.168.50.2:5690`                                                     |
| Bridge URL          | `http://192.168.50.2:8000` (separate project, `/volume1/docker/stripe-bridge`) |

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
- whether it is **pinned** (`...:2026.7.1`) or **floating** (`...:latest`),
- every `volumes:` line (confirm `wizarr-data` is the state directory),
- the published port (expected `5690`).

Note that `wizarr-data` is a **host bind mount**
(`/volume1/docker/westeroz/wizarr-data:/data`), not a named Docker volume. That is what
makes the step 3 backup and the step 6 restore ordinary filesystem operations on a path
you can `ls`. It also means `docker volume` commands will not find it, so do not go
looking for it there.

Then record the rollback coordinates from the _running container_, which is the only
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

### Which version is running, and is a newer one actually out?

A digest identifies bytes, not a version, and with a floating tag the tag tells you
nothing either. Wizarr uses CalVer (`2026.7.1`), and the only reliable in-image source is
`pyproject.toml`:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker exec wizarr grep -m1 "^version" /app/pyproject.toml'
```

Two traps here, both of which will hand you a confidently wrong version:

- **The OCI image labels lie.** `docker image inspect --format "{{json .Config.Labels}}"`
  reports `org.opencontainers.image.version` as a `uv` release (something like
  `0.11.26-python3.13-alpine3.23`, described as "An extremely fast Python package and
  project manager"). Those labels are inherited from the Astral `uv` base image and
  describe `uv`, not Wizarr. Never quote them as the Wizarr version.
- **The in-image `CHANGELOG.md` is stale.** It can be many releases behind
  `pyproject.toml`. Use it for reading notes, never for identifying the running version.

Then find out whether there is anything to take, **without pulling**. Compare the digest
the registry currently serves for the tag against the digest you recorded above:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:wizarrrr/wizarr:pull&service=ghcr.io" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" "https://ghcr.io/v2/wizarrrr/wizarr/manifests/latest" | grep -i docker-content-digest
```

This runs fine from the Mac; it is an anonymous read of a public registry and touches
neither the NAS nor the local image store.

- **Digest matches the running one**: there is no upgrade to take. Say so and stop. Do not
  run step 4 to "confirm", and do not take a backup you do not need.
- **Digest differs**: there is a new build. Now go read the release notes between the
  running version and the latest tag (github.com/wizarrrr/wizarr/releases) and judge it
  with step 6's migration test _before_ you upgrade, not after. Any release naming a
  migration, a schema change, or alembic makes the step 3 backup the difference between an
  inconvenience and a rebuild.

Wizarr ships alembic migrations in `/app/migrations/versions`, so "does this release
migrate" is always a real question, never a theoretical one.

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
admin router is the liveness probe, and `200` there would mean auth is _not_ wired.

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
only road back, and it has to exist _before_ the new image starts.

If nas-state-backup is unavailable, this is the minimum acceptable substitute. It stops
Wizarr so SQLite is not copied mid-write, and it tars through a throwaway container
because `docker` is the only binary available under non-interactive `sudo`.

**`alpine` is not present on the NAS**, so this pulls it from Docker Hub on first use. That
is the one part of the backup needing outbound network, and the part most likely to fail.
Pull it as its own command, so a registry problem surfaces while Wizarr is still up:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker pull alpine'
```

Then stop, tar, and restart. Note the `;` before the final `start`, not `&&`:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose stop wizarr; sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/westeroz/wizarr-data:/src:ro -v /volume1/docker/westeroz:/out alpine tar -czf /out/wizarr-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /src .; sudo -n /usr/local/bin/docker compose start wizarr'
```

That separator is load-bearing. Chained with `&&`, a failing `tar` (no `alpine`, full
volume, bad path) skips the `start` and **leaves Wizarr stopped** while you read the error,
turning a backup into an outage. With `;` the service always comes back, and you judge the
archive on its own evidence instead of on the exit code.

`sudo` is needed for the `docker` calls but not for the paths: `crivas` is uid 1026 and
owns both `/volume1/docker/westeroz` and `wizarr-data`, so the archive lands with no
ownership fight.

Then prove the archive is real. Existence is not enough, precisely because the `;` means
the `tar` may have failed:

```bash
ssh crivas@192.168.50.2 'ls -lht /volume1/docker/westeroz/wizarr-data-*.tar.gz | head -3; A=$(ls -t /volume1/docker/westeroz/wizarr-data-*.tar.gz | head -1); sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/westeroz:/b:ro alpine sh -c "gzip -t /b/$(basename $A) && echo ARCHIVE_OK"'
```

Want `ARCHIVE_OK`, a plausible size (not zero, not a few hundred bytes), and a timestamp
from the last few minutes. Confirm Wizarr came back too (re-run the step 2 probe) before
continuing.

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
see `apps/stripe-bridge/stripe_bridge/wizarr.py`), using the key the bridge itself holds:

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

Three things to get right. The run must point at whichever bridge you mean
(`BRIDGE_URL=http://192.168.50.2:8000` for the NAS one; it defaults to `localhost:8000`).
The `STRIPE_WEBHOOK_SECRET` in the environment must be the one that bridge verifies
against, or every webhook is rejected before it reaches Wizarr. And the script also needs
`WIZARR_BASE_URL` and `WIZARR_API_KEY` to read the invite back, so it exits immediately if
either is missing. There is **no `.env` at the repo root** (only `.env.example`), so supply
those four yourself, pointing `WIZARR_BASE_URL` at `http://192.168.50.2:5690` and reusing
the key the NAS bridge holds (the 5c one-liner reads it). Running this in step 2 as well
gives a clean before/after comparison and is worth the extra minute.

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

Scope the log read to the **current boot**, and only the current boot. A bare
`docker logs wizarr` replays every boot the container has ever had, and Wizarr prints
`Applying alembic migrations` plus `Database library migration` on _every_ start whether
or not anything actually moved. Grepping the full history therefore always "finds"
migrations, including from boots months ago:

```bash
ssh crivas@192.168.50.2 'S=$(sudo -n /usr/local/bin/docker inspect --format "{{.State.StartedAt}}" wizarr); sudo -n /usr/local/bin/docker logs --since "$S" wizarr 2>&1 | grep -iE "running upgrade|alembic.runtime.migration|will assume|batch_alter" | head -30'
```

The pattern is narrow on purpose. Do not widen it back to `migrat|schema`: that also
matches Wizarr's own boot banners and, worse, matches unrelated **Plex** log lines like
`503 Maintenance: Plex Media Server is currently running database migrations`, which say
nothing about Wizarr's schema.

The line that actually proves a schema change is `Running upgrade <rev> -> <rev>`. Alembic
context lines (`Context impl SQLiteImpl`, `Will assume non-transactional DDL`) print on
every boot and mean only that alembic ran, not that it changed anything.

Cross-check the release notes for every version between the old tag and the new one
(github.com/wizarrrr/wizarr/releases) for the words migration, schema, or breaking. Recent
history shows this is not hypothetical: `2026.4.0` fixed CASCADE data loss in an LDAP
migration, `2026.3.0` changed column addition to `batch_alter_table` for SQLite, and
`2025.12.0` merged migrations.

- **No migration lines and no migration in the release notes**: the database on disk is
  untouched, so a **plain image rollback is enough**. The old image opens the same file
  it wrote.
- **Any `Running upgrade <rev> -> <rev>` line, alembic output, or a release note naming a
  migration**: the database moved forward and cannot move back. The image rollback alone
  will fail, usually as a crash loop or an unknown-column error. You must **also restore
  `wizarr-data`** from the step 3 backup.
- **Cannot tell**: treat it as migrated. Restoring a good backup over an unmigrated
  database costs you nothing; skipping a needed restore costs you the invite system.

**Plain image rollback** (re-point the service at the digest recorded in step 1).

First confirm the old image is still on the box. If it was pruned, no amount of compose
editing will bring it back by digest without a network pull:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker image inspect --format "rollback target present: {{.Id}}" ghcr.io/wizarrrr/wizarr@sha256:<recorded-digest>'
```

Then back up the compose file:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && cp docker-compose.yml docker-compose.yml.pre-rollback'
```

Editing the compose file needs **no `sudo`**: it is owned by `crivas` and mode `rwxrwxrwx`,
so the "only `docker` under non-interactive `sudo`" constraint does not apply to it. Change
the single `image:` line in the `wizarr:` block to `ghcr.io/wizarrrr/wizarr@sha256:<digest>`
(a digest reference replaces the whole `repo:tag`; do not append it to `:latest`), then
confirm you changed the right line and only that line:

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

Restore `wizarr-data` from the step 3 archive. If nas-state-backup took the backup, use its
restore path rather than improvising. If you used the step 3 fallback tarball, this is its
matching restore, unpacking through a container for the same reason the backup did:

```bash
ssh crivas@192.168.50.2 'cd /volume1/docker/westeroz && mkdir -p wizarr-data && sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/westeroz/wizarr-data:/dst -v /volume1/docker/westeroz:/b:ro alpine tar -xzf /b/<archive-name>.tar.gz -C /dst'
```

Name the archive explicitly. Do not glob it: the newest `wizarr-data-*.tar.gz` may be one
you took _after_ the bad upgrade. Then confirm the database file is actually back before
starting anything:

```bash
ssh crivas@192.168.50.2 'ls -lh /volume1/docker/westeroz/wizarr-data/'
```

Re-point the image line as above, then:

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
- **Name the service on every compose command.** `westeroz` currently holds five services:
  `wizarr`, `tautulli`, `sabnzbd`, `radarr`, `sonarr`. An unscoped `pull` or `up -d`
  upgrades or recreates all of them, so a Wizarr upgrade becomes an unannounced *arr and
  SABnzbd upgrade that also interrupts in-flight downloads. Confirm the current list with
  `docker compose ps --services` rather than trusting this line.
- **Compose on this NAS is v2.20.1 and rejects Go-template `--format`.**
  `docker compose ps --format "{{.Service}}"` fails with `could not be parsed`. Use
  `--services`, or plain `docker compose ps`, or `docker inspect --format` on the container
  (which does support templates).
- **The image's OCI labels describe `uv`, not Wizarr.** Read the running version from
  `/app/pyproject.toml`, never from `.Config.Labels` and never from the in-image
  `CHANGELOG.md`, which lags by many releases. See step 1.
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

- **From and to**: the old CalVer version and digest (step 1) and the new one (step 5a),
  plus whether the tag is pinned or floating. If it is floating, say so and recommend
  pinning. If the registry digest already matched, report "already current" and that no
  upgrade was performed.
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
