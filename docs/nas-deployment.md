# Deploying the wizteros stack to a Synology NAS

Step-by-step runbook to move the **management stack** (Wizarr + Tautulli +
stripe-bridge + Cloudflare Tunnel) onto a Synology NAS and expose it publicly.

## What moves and what doesn't

- **Moves to the NAS:** `wizarr`, `tautulli`, `stripe-bridge`, `cloudflared`
  (this repo's `docker-compose.yml`).
- **Stays on the Mac Studio, untouched:** `radarr` / `sonarr` / `sabnzbd`
  (a separate media stack — not part of this repo).
- **Stays on the 5 NASes as-is:** the Plex servers. Wizarr reaches them over
  the LAN (`192.168.50.x`) no matter where Wizarr itself runs.
- **Carried over:** the live Wizarr data at `/Users/snowball/Docker/wizarr-data`
  (your 3 already-configured Plex servers + admin account + API key). Copying it
  means you do **not** re-add servers or regenerate the API key.

> Substitute these placeholders throughout:
> `<NAS_IP>` (the NAS's LAN IP), `<NAS_USER>` (a DSM admin account),
> `<domain>` (your name.com domain).

---

## Phase 0 — Pick the NAS

Any of the 5 NASes can host this — it's independent of which ones run Plex.
Pick the one that is **most reliably always-on**, since a sleeping host drops
the tunnel and Stripe cancellations stop reaching Wizarr. Note its LAN IP.

---

## Phase 1 — Prepare DSM (one-time)

1. **Install Container Manager.** DSM → *Package Center* → search
   **Container Manager** → Install. (On DSM 7.0/7.1 the package is called
   **Docker** — same engine.) This provides both `docker` and `docker compose`.
2. **Enable SSH.** DSM → *Control Panel* → *Terminal & SNMP* → check
   **Enable SSH service**. Note the port (default `22`).
3. **Create the `docker` shared folder.** Container Manager does not always
   create one. DSM → *Control Panel* → *Shared Folder* → **Create** → name it
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
TUNNEL_TOKEN=                           # filled in Phase 4 — leave empty for now
# PUBLIC_INVITE_BASE stays http/LAN until the tunnel is live (Phase 6)
```

> Leave `STRIPE_API_KEY` on the **test** key for now. Going live is a separate,
> later step (see `CLAUDE.md` → "What's next", steps 5–6).

---

## Phase 4 — Cloudflare: domain + tunnel

This is the part that actually makes the stack publicly reachable. **The
Mac-side steps and NAS deploy in Phase 5 will not work until this is done.**

1. **Add the domain to Cloudflare.** dash.cloudflare.com → *Add a site* →
   `<domain>` → Free plan → it lists two nameservers.
2. **Swap nameservers at name.com** to the two Cloudflare gave you. Then wait
   for activation (usually minutes, can be up to a few hours). Cloudflare emails
   you when the domain is **Active**. (Your DNS was verified clean, so nothing
   else is at risk — see `CLAUDE.md`.)
3. **Create the tunnel.** Cloudflare *Zero Trust* dashboard
   (one.dash.cloudflare.com) → *Networks* → *Tunnels* → **Create a tunnel** →
   connector **Cloudflared** → name it `wizteros` → Save.
4. **Copy the token.** The install command shown contains
   `--token eyJ...`. Copy that `eyJ...` value into `.env` on the NAS:
   ```sh
   TUNNEL_TOKEN=eyJ...
   ```
5. **Add the two public hostnames** (same tunnel → *Public Hostnames* tab):

   | Subdomain | Domain     | Type | URL                  |
   |-----------|------------|------|----------------------|
   | `invite`  | `<domain>` | HTTP | `wizarr:5690`        |
   | `webhook` | `<domain>` | HTTP | `stripe-bridge:8000` |

   Cloudflare auto-creates the `invite.` and `webhook.` DNS records. Use plain
   **HTTP** for the service URL — TLS is terminated at Cloudflare's edge; traffic
   from cloudflared to the containers stays inside the compose network.

---

## Phase 5 — Bring the stack up

SSH into the NAS and start everything. Synology puts docker at
`/usr/local/bin`; commands need `sudo`.

```sh
ssh <NAS_USER>@<NAS_IP>
cd /volume1/docker/wizteros
sudo docker compose up -d --build        # --build compiles the stripe-bridge image on the NAS
sudo docker compose ps                    # all four services should be "running"/"healthy"
sudo docker compose logs -f cloudflared   # look for "Registered tunnel connection"
```

If `docker compose` (v2) isn't found, use `sudo docker-compose` instead.

---

## Phase 6 — Point the world at the tunnel

Once `https://invite.<domain>` loads the Wizarr page:

1. **Stripe webhook.** Stripe Dashboard → *Developers* → *Webhooks* → set the
   endpoint to `https://webhook.<domain>/stripe/webhook` for events
   `checkout.session.completed` and `customer.subscription.deleted`. Copy the
   new signing secret into `.env` (`STRIPE_WEBHOOK_SECRET=`) and
   `sudo docker compose up -d stripe-bridge` to reload it.
2. **Netlify member link.** Netlify → the Westeroz site → *Environment
   variables* → set `VITE_MEMBER_URL=https://invite.<domain>` and redeploy. This
   reveals the member sign-in link on the landing page.
3. **Bridge invite base.** In `.env`, set
   `PUBLIC_INVITE_BASE=https://invite.<domain>` and
   `sudo docker compose up -d stripe-bridge`.

---

## Phase 7 — Verify end-to-end

1. `https://invite.<domain>` → Wizarr loads, your 3 Plex servers are still there.
2. `curl https://webhook.<domain>/health` (or the bridge's health route) → 200.
3. From the Stripe CLI in **test** mode:
   ```sh
   stripe trigger checkout.session.completed
   stripe trigger customer.subscription.deleted
   ```
   Watch `sudo docker compose logs -f stripe-bridge` for the Wizarr
   invite/removal calls.

---

## Cutover & rollback

- After Phase 7 passes, the old Mac-side Wizarr can stay stopped for good. If you
  need to roll back, `docker start wizarr` on the Mac restores the previous setup —
  the NAS copy is independent, so nothing is destroyed.
- The Mac Studio's `docker compose` at `/Users/snowball/Docker` and the media
  stack are unaffected throughout.

---

## Later (not part of this migration)

Going live is deliberately deferred — see `CLAUDE.md` → "What's next":
end-to-end test in Stripe **test** mode, then swap to **live** keys + a live
Payment Link + a live webhook endpoint, then announce.
