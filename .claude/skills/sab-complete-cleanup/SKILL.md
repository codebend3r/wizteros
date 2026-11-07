---
name: sab-complete-cleanup
description: Use when Vermithor's SABnzbd Complete folder is filling up, or when installing, checking or changing the nightly job that clears it. Triggers include "clean up SABnzbd Complete", "the downloads folder is full", "is the SAB cleanup still running", "install the cleanup script on Vermithor", "dry run the Complete cleanup", "why was this download deleted". Only applies to the wizteros repo.
---

# SABnzbd Complete cleanup

## Overview

Radarr and Sonarr remove what they import, so anything still sitting in Vermithor's
SABnzbd Complete folder was sent to SABnzbd another way and nothing else will ever
delete it. `scripts/sab_complete_cleanup.py` runs nightly on Vermithor as root and
deletes an entry only when it is past the grace period (24h), SABnzbd is not still
post-processing it, it is not a symlink, and it is one of:

- a TV release (an `SxxEyy` or `Sxx` tag in the name), or
- a movie Radarr's own parser (`GET /api/v3/parse`) matches to a movie that already
  has a file.

Everything else stays and is logged with its reason: `active`, `too-new`, `symlink`,
`unknown-movie` (Radarr cannot match it, music included), or `not-imported` (Radarr
tracks the movie but has no file, so this is the only copy).

`judge()` is the whole rule. Change it there, with a test, never by adding a branch to
`sweep()` or `main()`.

## Nothing is hard-coded

The script reads the stack from the running containers: the `sabnzbd` and `radarr`
compose services' port bindings and `/config` mounts, and SABnzbd's own `complete_dir`
mapped to the host through its mounts. Its log is `../logs/sab-complete-cleanup.log`
beside wherever it is installed, rotated at 2 MB. If docker, SABnzbd or Radarr cannot
be read it logs `ABORT` and exits 1.

## Running it

```bash
.claude/skills/sab-complete-cleanup/scripts/install.sh --check   # does the NAS copy match the repo?
.claude/skills/sab-complete-cleanup/scripts/install.sh           # install the repo's copy
```

The installer puts the script in the `scripts/` folder of the compose project the
`sabnzbd` container runs in, and prints the task command. Vermithor's docker sudo needs
its password from the keychain (`nas setpw vermithor` once if it is missing).

A dry run on the NAS, which deletes nothing:

```bash
ssh -t "$(scripts/nas-host.sh vermithor)" "sudo /usr/bin/python3 <installed path>"
```

## The scheduled task (manual, in DSM)

Creating a DSM task needs the DSM UI. Control Panel → Task Scheduler → Create →
Scheduled Task → User-defined script: user `root`, daily at 02:00, command as printed by
the installer (`/usr/bin/python3 <installed path> --apply`). Check it exists with
`ls /usr/syno/etc/synoschedule.d/root/` over ssh; a deleted task leaves only a
`N.backup/` folder behind.

## Tests

`scripts/test_sab_complete_cleanup.py`, run by `bun run test:tooling` (and so by
`verify` and CI). Keep it Python 3.8 compatible, since that is what DSM ships: run the
tests on Vermithor too after changing the script.

## Red flags

- About to delete something by hand because the script kept it → read its `kept` reason
  first. `not-imported` means it is the only copy.
- Adding a path, port or project name as a constant → read it from the containers.
- `install.sh --check` says `differs` → the scheduler runs whatever is on the NAS, not
  the repo. Install, or find out who changed it there.
