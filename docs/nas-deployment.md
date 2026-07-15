# Deploying the wizteros stack to a Synology NAS

Step-by-step runbook to move the **management stack** (Wizarr + Tautulli +
stripe-bridge) onto a Synology NAS. Public ingress (so Stripe and members can
reach it) is handled separately by Tailscale Funnel — see
[`tailscale-funnel.md`](./tailscale-funnel.md).

## What moves and what doesn't

- **Moves to the NAS:** `wizarr`, `tautulli`, `stripe-bridge`
  (this repo's `docker-compose.yml`).
- **Stays on the Mac Studio, untouched:** `radarr` / `sonarr` / `sabnzbd`
  (a separate media stack — not part of this repo).
- **Stays on the 5 NASes as-is:** the Plex servers. Wizarr reaches them over
  the LAN (`192.168.50.x`) no matter where Wizarr itself runs.
- **Carried over:** the live Wizarr data at `/Users/snowball/Docker/wizarr-data`
  (your 3 already-configured Plex servers + admin account + API key). Copying it
  means you do **not** re-add servers or regenerate the API key.

> Substitute these placeholders throughout:
> `<NAS_IP>` (the NAS's LAN IP), `<NAS_USER>` (a DSM admin account).

---

## Phase 0 — Pick the NAS

Any of the 5 NASes can host this — it's independent of which ones run Plex.
Pick the one that is **most reliably always-on**, since a sleeping host drops
public ingress and Stripe cancellations stop reaching Wizarr. Note its LAN IP.

---

## Phase 1 — Prepare DSM (one-time)

1. **Install Container Manager.** DSM → _Package Center_ → search
   **Container Manager** → Install. (On DSM 7.0/7.1 the package is called
   **Docker** — same engine.) This provides both `docker` and `docker compose`.
2. **Enable SSH.** DSM → _Control Panel_ → _Terminal & SNMP_ → check
   **Enable SSH service**. Note the port (default `22`).
3. **Create the `docker` shared folder.** Container Manager does not always
   create one. DSM → _Control Panel_ → _Shared Folder_ → **Create** → name it
   `docker` on the Meleys volume (defaults are fine; give your admin user
   Read/Write). Full path becomes `/volume1/docker` (adjust `volume1` if your
   volume differs). You don't need to create the `wizteros` sub-folder by hand —
   the `rsync` in Phase 2 creates it.
4. **Find your UID/GID.** SSH in and run `id`:
   ```sh
   ssh <NAS_USER>@<NAS_IP>
   id          # note uid=NNNN and gid=NNNN — you'll put these in .env
   ```
   Synology admin accounts are rarely `1000`, which is why the compose reads
   `PUID`/`PGID` from `.env`.

---

## Phase 2 — Copy the code and data onto the NAS

Run these **from the Mac Studio**.

1. **Stop the old Wizarr first** so its SQLite DB isn't mid-write during the
   copy (brief downtime is fine — no external users yet):
   ```sh
   docker stop wizarr        # the one from /Users/snowball/Docker
   ```
2. **Copy this repo** (excluding git history and local junk) to the NAS:
   ```sh
   rsync -av --exclude '.git' --exclude 'venv' --exclude 'node_modules' \
     /Users/snowball/Developer/git/wizteros/ \
     <NAS_USER>@<NAS_IP>:/volume1/docker/wizteros/
   ```
3. **Copy the live Wizarr data** into the stack's expected location:
   ```sh
   rsync -av /Users/snowball/Docker/wizarr-data/ \
     <NAS_USER>@<NAS_IP>:/volume1/docker/wizteros/wizarr-data/
   ```
4. **Fix ownership** so the containers can write (use the uid/gid from Phase 1.4):
   ```sh
   ssh <NAS_USER>@<NAS_IP>
   sudo chown -R <uid>:<gid> /volume1/docker/wizteros/wizarr-data \
                              /volume1/docker/wizteros/tautulli-config \
                              /volume1/docker/wizteros/stripe-bridge-data
   ```

---

## Phase 3 — Configure `.env` on the NAS

The `.env` you copied already has your Stripe keys, Wizarr API key, and Payment
Link. Edit it on the NAS (`/volume1/docker/wizteros/.env`) and change these:

```sh
PUID=<uid>                              # from Phase 1.4
PGID=<gid>                              # from Phase 1.4
WIZARR_BASE_URL=http://wizarr:5690      # bridge reaches Wizarr by service name now
# PUBLIC_INVITE_BASE stays on the LAN until Tailscale Funnel is up (tailscale-funnel.md)
```

> Leave `STRIPE_API_KEY` on the **test** key for now. Going live is a separate,
> later step (see `CLAUDE.md` → "What's next", steps 5–6).

---

## Phase 4 — Bring the stack up

SSH into the NAS and start the three services. Synology puts docker at
`/usr/local/bin`; commands need `sudo`.

```sh
ssh <NAS_USER>@<NAS_IP>
cd /volume1/docker/wizteros
# Synology's Docker won't auto-create bind-mount dirs (Docker Desktop does).
# Pre-create the ones that don't come from the data copy:
mkdir -p tautulli-config stripe-bridge-data
sudo docker compose up -d --build wizarr tautulli stripe-bridge   # --build compiles the bridge image
sudo docker compose ps                                            # all three should be running/healthy
```

If `docker compose` (v2) isn't found, use `sudo docker-compose` instead. Then
open `http://<NAS_IP>:5690` — Wizarr should load with your Plex servers intact.

---

## Phase 5 — Public ingress

The stack is now running but only reachable on the LAN. To expose Wizarr and the
Stripe webhook to the internet (free, no domain), follow
[`tailscale-funnel.md`](./tailscale-funnel.md). It also covers wiring
`PUBLIC_INVITE_BASE`, the Netlify member link, the Stripe webhook endpoint, and
the end-to-end test.

---

## Cutover & rollback

- After the Tailscale end-to-end test passes, the old Mac-side Wizarr can stay stopped for good. If you
  need to roll back, `docker start wizarr` on the Mac restores the previous setup —
  the NAS copy is independent, so nothing is destroyed.
- The Mac Studio's `docker compose` at `/Users/snowball/Docker` and the media
  stack are unaffected throughout.

---

## Later (not part of this migration)

Going live is deliberately deferred — see `CLAUDE.md` → "What's next":
end-to-end test in Stripe **test** mode, then swap to **live** keys + a live
Payment Link + a live webhook endpoint, then announce.
