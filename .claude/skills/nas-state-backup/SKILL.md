---
name: nas-state-backup
description: Use when the live wizteros state on the Synology NAS needs a snapshot before something can destroy it, or when the user asks whether any of it is backed up at all. Triggers include "back up the NAS state", "backup before upgrading wizarr", "snapshot the bridge db", "snapshot wizarr-data", "is the wizarr database backed up anywhere", plus anything about to touch live NAS state: a Wizarr or Tautulli image upgrade, recreating or deleting a container, hand-editing a bind-mounted data dir, or restoring one of those dirs from an earlier snapshot. Only applies to the wizteros repo.
---

# Back up the live NAS state for wizteros

## Overview

`deploy-nas` ships code and deliberately refuses to touch live NAS state. That is the
right call, and it leaves a hole: nothing backs that state up. This skill fills it with
timestamped, verified tarballs written NAS-side.

What is at risk:

| Dir | Project | Why losing it hurts |
|---|---|---|
| `wizarr-data/` | `westeroz` | Wizarr's whole DB, including the **healed library-name cache**. Lose it and invite redemption breaks again, the same failure the healing pass was written to fix. |
| `tautulli-config/` | `westeroz` | All Tautulli history and settings. Not load bearing for payments, unrecoverable if lost. |
| `stripe-bridge-data/` | `stripe-bridge` | `bridge.db`: the Stripe customer to Wizarr invite mapping, member notes, tags, processed-event ids. Lose it and live subscribers stop reconciling. |

This is a **production data** operation on a live stack. It only ever reads, but it runs
`docker exec` against the running bridge, so run it deliberately.

## Running It

```bash
.claude/skills/nas-state-backup/scripts/backup.sh --dry-run   # always first
.claude/skills/nas-state-backup/scripts/backup.sh
.claude/skills/nas-state-backup/scripts/backup.sh --pull
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Print every action, perform none. It still queries the NAS read-only, so the plan it prints is the real plan, not a guess. |
| `--pull` | After the NAS-side backup, also copy the new snapshot dir to the Mac under `~/Backups/wizteros/`. |

| Env override | Default |
|---|---|
| `WZ_NAS_HOST` | `crivas@192.168.50.2` |
| `WZ_NAS_PATH` | `/volume1/docker/stripe-bridge` |
| `WZ_WESTEROZ_PATH` | `/volume1/docker/westeroz` |
| `WZ_BACKUP_ROOT` | `/volume1/docker/backups` |
| `WZ_BACKUP_KEEP` | `7` |
| `WZ_PULL_DEST` | `~/Backups/wizteros` |
| `WZ_MIN_ARCHIVE_BYTES` | `1024` |

Run it as a single Bash invocation so the user sees the whole transcript. Default to
`--dry-run` when the user is asking "is this backed up" rather than "back this up".

## What It Does

1. **Preflight**, then **locates the state dirs at runtime**. It checks both
   `/volume1/docker/westeroz/` and `/volume1/docker/stripe-bridge/` for all three dirs
   and backs up whatever it actually finds. It reports each found location and warns
   loudly about any dir found in neither place. Nothing is assumed to live where the
   docs say it lives, because that layout has already moved once.
2. **Snapshots the live SQLite db** (see below).
3. **Tars each found dir** into `/volume1/docker/backups/<UTC timestamp>/`, NAS-side over
   one-shot SSH. Archives are named `<project>--<dir>.tar.gz`
   (`westeroz--wizarr-data.tar.gz`, `stripe-bridge--stripe-bridge-data.tar.gz`), so the
   restore target is readable off the filename and the same dir found in two projects
   cannot overwrite itself.
4. **Verifies** each archive by reading it back (`tar -tzf`) and checking it clears a size
   floor, then prints per-archive sizes. A failed archive makes the whole run exit 1.
5. **Writes `MANIFEST.txt`** into the snapshot dir recording which archive came from which
   path and whether the db snapshot was taken.
6. **Prunes** to the newest 7 snapshots.

Nothing streams through the Mac unless `--pull` is given, and the only paths it writes to
are the snapshot dir and one temporary db snapshot inside the bind mount.

## `.env` Is Never Backed Up

Not "excluded by default", not "excluded unless you ask". Never. `.env` holds the live
Stripe API key, the Wizarr API key, the webhook signing secret and SMTP credentials. A
plaintext copy of that sitting in a backup dir, or pulled onto a laptop with `--pull`, is
a secret leak wearing a safety-net costume. The tars carry `--exclude '.env'` even though
`.env` lives beside these dirs rather than inside them.

If `.env` is ever lost, rebuild it from `.env.example` plus the Stripe and Wizarr
dashboards. That is a twenty minute job. A leaked live key is not.

## The Live SQLite Snapshot

`bridge.db` is written while the container runs, so tarring it raw can catch a torn page
or miss a hot WAL. So, when the container is running:

- The script runs sqlite3's `.backup` **inside the `stripe-bridge` container**, via
  `sudo -n /usr/local/bin/docker exec`, writing to `/data/bridge.db.snapshot`. `/data` is
  the bind mount, so the file lands in `stripe-bridge-data/` on the host and the tar picks
  it up.
- **The image has no `sqlite3` binary.** `stripe-bridge` builds `FROM python:3.12-slim`,
  which ships no CLI. The working path is therefore the Python stdlib:
  `python3 -c "import sqlite3; src = sqlite3.connect('/data/bridge.db'); dst = sqlite3.connect('/data/bridge.db.snapshot'); src.backup(dst); dst.close(); src.close()"`.
  The script probes for the `sqlite3` binary first and falls back to this; the probe only
  exists so a future base image that has the CLI takes the shorter route.
- The temp snapshot is **removed after the tar**, by an `EXIT` trap, so it goes away even
  if the run dies partway. It is written by the container as root, so cleanup falls back
  to `docker exec ... rm` if the host-side `rm` is refused.
- **The archive therefore contains both files**: the live `bridge.db` (possibly torn) and
  `bridge.db.snapshot` (consistent). The restore below uses the snapshot. That is the one
  detail worth remembering from this section.

If the container is not running, the script says so and tars `bridge.db` directly, which
is consistent precisely because nothing is writing to it.

## Retention

Keeps the newest 7 snapshot dirs (`WZ_BACKUP_KEEP`), deletes the rest, and prints every
path it pruned. Only directories matching the exact `YYYYMMDDTHHMMSSZ` name pattern are
ever eligible for deletion, so anything else parked under the backups root is untouched.
The script also refuses a backup root shallower than three path segments, because
retention issues `rm -rf` under it.

## Restore

Confirm the service names first; the `westeroz` compose file is NAS-side only and this
repo does not define it.

```bash
ssh crivas@192.168.50.2 "cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose ps"
```

Throughout, `BK=/volume1/docker/backups/<TIMESTAMP>`. Read `MANIFEST.txt` in that dir
first to confirm which archive maps to which path.

### `wizarr-data`

```bash
# 1. stop the owning container
ssh crivas@192.168.50.2 "cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose stop wizarr"

# 2. move the live dir aside rather than deleting it; this is your undo
ssh crivas@192.168.50.2 "cd /volume1/docker/westeroz && mv wizarr-data wizarr-data.pre-restore"

# 3. untar into the parent (archives carry the dir name, so this recreates wizarr-data/)
ssh crivas@192.168.50.2 "tar -xzf \$BK/westeroz--wizarr-data.tar.gz -C /volume1/docker/westeroz"

# 4. check ownership matches PUID/PGID from /volume1/docker/stripe-bridge/.env
ssh crivas@192.168.50.2 "ls -ln /volume1/docker/westeroz/wizarr-data | head"

# 5. start and verify
ssh crivas@192.168.50.2 "cd /volume1/docker/westeroz && sudo -n /usr/local/bin/docker compose start wizarr"
ssh crivas@192.168.50.2 "curl -s -o /dev/null -m 5 -w '%{http_code}\n' http://localhost:5690"
```

Wizarr answering on `:5690` is the check. Then open it and confirm the Plex servers and
the API key survived; that is what `wizarr-data` is really for.

If step 4 shows the wrong owner, note that **the NOPASSWD sudoers rule covers only
`/usr/local/bin/docker`**, so a plain `sudo chown` will sit there wanting a password and
fail in a one-shot SSH. Either fix it from an interactive SSH session, or borrow root
through the rule you already have:

```bash
ssh crivas@192.168.50.2 "sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/westeroz:/fix wizteros-stripe-bridge chown -R <PUID>:<PGID> /fix/wizarr-data"
```

### `tautulli-config`

Identical to `wizarr-data`, with `tautulli` as the service, `westeroz--tautulli-config.tar.gz`
as the archive, and `http://localhost:8181` as the check.

### `stripe-bridge-data`

```bash
ssh crivas@192.168.50.2 "cd /volume1/docker/stripe-bridge && sudo -n /usr/local/bin/docker compose stop stripe-bridge"
ssh crivas@192.168.50.2 "cd /volume1/docker/stripe-bridge && mv stripe-bridge-data stripe-bridge-data.pre-restore"
ssh crivas@192.168.50.2 "tar -xzf \$BK/stripe-bridge--stripe-bridge-data.tar.gz -C /volume1/docker/stripe-bridge"

# THE STEP PEOPLE FORGET: promote the consistent snapshot over the raw live copy,
# and drop the WAL/SHM sidecars, which belong to the old bridge.db and would
# corrupt reads against the snapshot.
ssh crivas@192.168.50.2 "cd /volume1/docker/stripe-bridge/stripe-bridge-data && rm -f bridge.db-wal bridge.db-shm && mv bridge.db.snapshot bridge.db"

ssh crivas@192.168.50.2 "cd /volume1/docker/stripe-bridge && sudo -n /usr/local/bin/docker compose start stripe-bridge"
ssh crivas@192.168.50.2 "curl -s -o /dev/null -m 5 -w '%{http_code}\n' http://localhost:8000/admin/members"
```

**`401` is the pass, not `200`.** There is no `/health` route; `/admin/members` returning
`401` proves FastAPI mounted and auth is wired, which a bare port check would not. This
matches the `deploy-nas` liveness probe.

If the snapshot is absent (container was down at backup time), `bridge.db` in the archive
is already the good copy and there is nothing to promote.

Leave the `.pre-restore` dirs in place until the restored stack has been exercised, then
remove them by hand. They are the only undo.

## Reporting Back

Summarize: which dirs were found and where, the snapshot id, per-archive sizes, whether
the db snapshot was taken or skipped, and what retention pruned. Call out any state dir
that was not found anywhere, since that is either a layout change or missing data, and
both matter more than the backup itself.

If any archive failed verification, lead with that: the run exits 1 and the snapshot dir
must not be trusted.

## Red Flags

- **Restoring `wizarr-data` over a newer Wizarr schema.** If Wizarr was upgraded after the
  backup was taken, the image will try to migrate an old DB forward, or refuse. Pin the
  Wizarr image back to the version that was running when the snapshot was taken, restore,
  confirm it boots, then upgrade forward again. Never restore an old `wizarr-data` under a
  new image and hope.
- **Backing up mid-upgrade.** A snapshot taken while a container is recreating, migrating,
  or half-started captures a half-migrated DB, which is worse than no backup because it
  looks like one. Back up **before** you start, or after the upgrade has settled and been
  verified. Never during.
- **Treating this as offsite storage.** `/volume1/docker/backups` sits on the same volume
  as the data it protects. If `/volume1` dies, the backups die with it. This protects
  against bad upgrades, container recreates, and fat fingers. It does not protect against
  disk or volume loss. Offsite is a real gap and is out of scope here; say so plainly
  rather than letting the word "backup" imply more than it delivers. `--pull` puts one
  copy on the Mac, which is a second machine, not a backup strategy.
- **Reaching for `.env`.** It is not in any archive and must not be added to one.
- **Skipping `--dry-run` on the first run in a while.** Layouts drift. The dry run is what
  tells you a state dir moved before you find out from an empty archive.
