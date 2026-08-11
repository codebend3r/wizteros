# The *arr media stacks on the NAS

Reference for the media-automation containers that live alongside this repo's own
services on the Synology boxes: what runs where, how to update it, and what will bite
you. The runbook itself is automated — see the `arr-stack-update` skill.

This stack is **not built from this repo**. Every service tracks a floating upstream tag,
so there is no version to bump here and nothing in `CHANGELOG.md` moves when it updates.
The repo owns only `stripe-bridge`; see [`nas-deployment.md`](./nas-deployment.md).

## Where things run

Only two of the five NASes run docker at all.

| Host | IP | Compose project | Directory |
|---|---|---|---|
| Meleys | `192.168.50.2` | `westeroz` | `/volume1/docker/westeroz` |
| Vermithor | `192.168.50.3` | `essoz` | `/volume1/docker/essoz` |

Meleys additionally runs the `stripe-bridge` project from
`/volume1/docker/stripe-bridge`, which is this repo's deploy target and is never
touched by an *arr update.

### Meleys — `westeroz`

| Service | Image | Host port | Config volume |
|---|---|---|---|
| `sonarr` | `lscr.io/linuxserver/sonarr:latest` | 27021 → 8989 | `westeroz/Sonarr/config` |
| `radarr` | `lscr.io/linuxserver/radarr:latest` | 7878 | `westeroz/Radarr/config` |
| `sabnzbd` | `lscr.io/linuxserver/sabnzbd:latest` | 27020 → 8080 | `westeroz/SABnzbd/config` |
| `wizarr` | `ghcr.io/wizarrrr/wizarr:latest` | 5690 | `westeroz/wizarr-data` |
| `tautulli` | `ghcr.io/tautulli/tautulli:latest` | 8181 | `westeroz/tautulli-config` |

### Vermithor — `essoz`

| Service | Image | Host port | Config volume |
|---|---|---|---|
| `sonarr` | `lscr.io/linuxserver/sonarr:latest` | 27021 → 8989 | `essoz/Sonarr/config` |
| `radarr` | `lscr.io/linuxserver/radarr:latest` | 7878 | `essoz/Radarr/config` |
| `lidarr` | `lscr.io/linuxserver/lidarr:latest` | 8686 | `essoz/Lidarr/config` |
| `prowlarr` | `lscr.io/linuxserver/prowlarr:latest` | 9696 | `essoz/Prowlarr/config` |
| `sabnzbd` | `lscr.io/linuxserver/sabnzbd:latest` | 27020 → 8080 | `essoz/SABnzbd/config` |
| `seerr` | `ghcr.io/seerr-team/seerr:latest` | 5055 | `essoz/Overseerr/config` |
| `bookshelf` | `ghcr.io/pennydreadful/bookshelf:hardcover` | 8787 | `essoz/Bookshelf/config` |
| `audiobookshelf` | `ghcr.io/advplyr/audiobookshelf:latest` | 13378 → 80 | `essoz/Audiobookshelf/config` |
| `tautulli` | `lscr.io/linuxserver/tautulli:latest` | 27022 → 8181 | `essoz/Tautulli/config` |

Both hosts run a `sonarr`, a `radarr` and a `sabnzbd`, on the same host ports.
**Always name the host.** "Restart sonarr" is ambiguous and has been acted on against
the wrong box before.

Media is bind-mounted per-NAS under each host's own share — Vermithor's containers see
`/Syrax`, `/Vhagar`, `/Caraxes`, `/Meleys`, `/Vermithor`, and Meleys' see the mirrored
set. Both stacks' `downloads/Complete` and `downloads/Incomplete` are local to the host.

> **Stale data dirs.** `westeroz/` still holds `Prowlarr/`, `Lidarr/` and `Overseerr/`
> (~7 GB) from an earlier layout where Meleys ran those too. No container references
> them. Leave them or delete them deliberately — nothing reads them.

## Updating

```bash
.claude/skills/arr-stack-update/scripts/update-arr-stack.sh meleys
.claude/skills/arr-stack-update/scripts/update-arr-stack.sh all --check
```

The script discovers each stack from container labels, pulls, recreates only the
services whose image ID actually moved, waits for each one to answer on its published
port, and rolls back any that do not. `SKILL.md` in that skill directory documents every
flag.

By hand, the equivalent is:

```bash
ssh crivas@192.168.50.2 "cd /volume1/docker/westeroz && \
  sudo -n /usr/local/bin/docker compose pull sonarr radarr sabnzbd && \
  sudo -n /usr/local/bin/docker compose up -d sonarr radarr sabnzbd"
```

Note the literal `/usr/local/bin/docker`: docker is not on the non-interactive `PATH`,
and the socket is root-owned, so every call needs sudo. **Meleys has a NOPASSWD rule for
that exact path; Vermithor does not** and will prompt — the script reads that password
from the login keychain (service `synology-nas`, account = hostname), where the personal
`nas` helper stores it.

Never run a bare `compose up -d` with no service list. It restarts the whole project,
including the stateful services below.

## What not to update casually

`wizarr` and `tautulli` sit in these same compose projects but hold live production
state, so the update script skips them unless `--include-stateful` is passed:

- **`wizarr`** — the member database and the healed library-name cache. Losing or
  corrupting it re-breaks invite redemption. Snapshot with the `nas-state-backup` skill,
  and prefer `wizarr-upgrade`, which judges whether a release is safe to take.
- **`tautulli`** — the full watch history, which is not reconstructible.

`stripe-bridge` is excluded unconditionally: it is built from this repo's source rather
than pulled, and `deploy-nas` owns its lifecycle.

## Rollback

Superseded images stay on disk until something prunes them, and that is the rollback
path:

```bash
sudo -n /usr/local/bin/docker tag <old-image-id> lscr.io/linuxserver/sonarr:latest
sudo -n /usr/local/bin/docker compose up -d --force-recreate sonarr
```

**The image alone may not be enough.** Sonarr and Radarr migrate their SQLite schema on
first boot of a new major version, and the older binary can refuse a migrated `*.db`. If
a rolled-back container still fails to start, restore that service's `config/` directory
from a snapshot as well. Take one before a major bump if the service matters that day.

Reclaim the old layers with `--prune` on the script, or `docker image prune -f` — but
only once the update is confirmed good.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker: command not found` over SSH | Not on the non-interactive `PATH` | Use `/usr/local/bin/docker` |
| `sudo: no password was provided` | Vermithor has no NOPASSWD rule, or the stored password is wrong for that box | `nas setpw vermithor` — passwords are per-NAS |
| Service answers `302` or `401` after an update | Normal. Sonarr redirects to its login, some apps 401 unauth'd | Not a failure |
| A container restarts in a loop after an update | Usually a config schema the new major rejects | Read `docker logs`, then roll back image **and** config |
| SABnzbd queue looks stalled after a recreate | It resumes from the bind-mounted config, but a long download may need a nudge | Check the queue is moving; re-queue if not |
| Update says "already current" but the app shows an older version | The tag has not moved upstream yet; linuxserver rebuilds trail upstream releases | Wait, or pin a specific tag deliberately |
