# Deploying the fleet monitor

How the `/fleet` page gets data on the production portal (Netlify), not just
against a monitor you started by hand on the LAN.

## Why a LAN address cannot work

The portal is served over https from Netlify. A page on https may not fetch a
plain-http subresource — the browser blocks it as mixed content before the
request is made — and a public page fetching an RFC1918 address is blocked
again by Private Network Access. So `VITE_FLEET_BASE=http://192.168.50.3:8010`
fails in production no matter what else is configured, and the page reports a
monitor that is down while the monitor is fine.

The fix is the one the bridge already uses: publish it over the Tailscale
Funnel that meleys is already running, and authorize each read.

|              | Bridge                              | Monitor           |
| ------------ | ----------------------------------- | ----------------- |
| Runs on      | meleys :8000                        | meleys :8010      |
| Funnel mount | `/stripe`                           | `/monitor`        |
| Portal env   | `VITE_ADMIN_API_BASE`               | `VITE_FLEET_BASE` |
| Auth         | Supabase session, allowlisted email | same              |

The Funnel strips the mount prefix, so `/monitor/fleet/cpu` reaches the
container as `/fleet/cpu`.

## What is exposed, and what protects it

Funnel is the public internet. `/fleet`, the four history routes (`/fleet/cpu`,
`/fleet/memory`, `/fleet/gpu`, `/fleet/network`), `/incidents` and the six play
history routes (`/plays/overview`, `/plays/users`, `/plays/users/{id}/history`,
`/plays/top`, `/plays/never-played`, `/plays/sync`) all require
`Authorization: Bearer <supabase jwt>` whose ES256 signature verifies against
the project's published keys and whose email is in `FM_ADMIN_ALLOWED_EMAILS`.
Unset config rejects rather than passes: a half-configured container is shut,
not open.

The play history routes read a ledger the collector fills from each Plex
server's own `/status/sessions/history/all`, so they carry every member's
completed plays. That is admin data, which is why they sit behind the same
gate as everything else and why `/plays/*` is never mounted anywhere else.

`/health` is deliberately ungated — the container healthcheck and the Funnel
both probe it without a session, and it reports only liveness and staleness.

## One-time setup

### 1. Mint an ssh key for the collector

The collector reaches all five hosts over ssh. It needs its own key, **not** a
copy of a human's: revoking the monitor should be deleting one
`authorized_keys` line. As of this writing `crivas` on meleys has no private
key at all, so this step is required, not a check.

On meleys:

```bash
mkdir -p /volume1/docker/stripe-bridge/fleet-monitor-ssh
ssh-keygen -t ed25519 -N '' -C 'fleet-monitor' \
  -f /volume1/docker/stripe-bridge/fleet-monitor-ssh/id_ed25519
chmod 700 /volume1/docker/stripe-bridge/fleet-monitor-ssh
chmod 600 /volume1/docker/stripe-bridge/fleet-monitor-ssh/id_ed25519
```

Then append that public key to `~crivas/.ssh/authorized_keys` on **all five**
hosts — meleys included, since the collector ssh-es to the box it runs on:

```bash
cat /volume1/docker/stripe-bridge/fleet-monitor-ssh/id_ed25519.pub
# paste into ~/.ssh/authorized_keys on
#   192.168.50.2 meleys   .3 vermithor   .4 caraxes   .5 syrax   .6 vhagar
```

A host missing the key is not an outage: that host reports as never collected,
with no line on the chart. Which is the honest rendering, and also how you can
tell which one you missed.

### 2. Fill in the monitor's env

In `/volume1/docker/stripe-bridge/.env` on the NAS (the deploy script never
overwrites it):

```
FM_SUPABASE_URL=https://<project>.supabase.co
FM_ADMIN_ALLOWED_EMAILS=you@example.com
FM_SSH_USER=crivas
FM_PLEX_LOOKBACK_DAYS=365
```

Same values the bridge's `SUPABASE_URL` and `ADMIN_ALLOWED_EMAILS` hold. They
are named apart because each service reads its own env.

The play history collector authenticates to every Plex server with the owner
token. It reads `FM_PLEX_TOKEN` and falls back to the `PLEX_TOKEN` the bridge
already holds in the same file, so nothing extra is needed on a NAS that has
the bridge configured. Two of the five servers (vermithor, vhagar) accept
secure connections only; the collector speaks https to those and skips
certificate verification, because Plex's `*.plex.direct` certificate cannot
match a LAN address. The token still authorizes every request, and the
addresses are fixed in `fleet_monitor/config.py` beside the Docker endpoints.

`FM_PLEX_LOOKBACK_DAYS` bounds only the first backfill on a fresh database.
Every later pass continues from the newest play it stored, re-reading a two
day overlap so a collector outage is a delay rather than a hole. Nothing is
pruned by age.

Some libraries are not what the page is about. `FM_PLEX_EXCLUDED_PATHS` is a
comma-separated list of folders whose libraries the collector leaves out
entirely, defaulting to `/volume1/Caraxes/tmp`: the scratch tree caraxes
indexes as four movie libraries (tutorials, home videos, documents,
assignments). A library is excluded when every folder it points at sits inside
an excluded one, so a library straddling a scratch folder and a real one is
still counted. The rule is applied by the inventory pass, which runs on the
first round after a restart: it marks those libraries, deletes the plays and
items already stored for them, and never lists them again. The history pass
reads the marks and drops their plays before storing anything. An empty value
switches the rule off again, and the next inventory re-lists those libraries,
but plays a purge already deleted do not come back: the history cursor only
moves forward, so the ledger is never re-read that far back.

### 3. Deploy the containers

```bash
bun run deploy:nas          # syncs code; never touches .env or the state dirs
```

Then on the NAS:

```bash
cd /volume1/docker/stripe-bridge
sudo docker compose up -d --build fleet-monitor fleet-collector
sudo docker compose logs -f fleet-collector    # first round takes ~30s
```

`fleet-monitor` serves the API, `fleet-collector` fills the database. Split so
a collector wedged on a slow box does not take the dashboard down with it.

### 4. Mount it on the Funnel

**Use `funnel`, never `serve`.** They write the same config, and `serve` turns
the Funnel _off_ for the whole node — which silently takes Wizarr and the
bridge off the public internet along with it. Stripe webhooks stop arriving,
public invite links die, and `/manage` on the deployed portal breaks. `serve`
says "Removing Funnel for ...:443" and "Available within your tailnet" on its
way past; `funnel` says "Available on the internet". Read that line.

The full path is required: `tailscale` is not on the login PATH, and sudo's
`secure_path` does not cover `/usr/local/bin`. A typed password is required
too — the NOPASSWD rule covers `/usr/local/bin/docker` only.

```bash
ssh -t crivas@192.168.50.2 \
  'sudo /usr/local/bin/tailscale funnel --bg --set-path /monitor http://127.0.0.1:8010'

/usr/local/bin/tailscale funnel status   # no sudo needed to read it
```

Expect all three paths under a header reading **"Available on the internet"**.
`AllowFunnel` is keyed on `host:443` rather than per path, which is both why
one `serve` takes everything down and why one `funnel` brings it all back.

### 5. Point the portal at it

Netlify → Site configuration → Environment variables:

```
VITE_FLEET_BASE = https://meleys.tail5586d4.ts.net/monitor
```

`VITE_*` values are compiled into the bundle at build time, so this needs a
redeploy to take effect — a new build, not just a saved variable.

## Verifying

```bash
# ungated, from anywhere
curl -s https://meleys.tail5586d4.ts.net/monitor/health

# gated: 401 without a session is the correct answer, not a failure
curl -s -o /dev/null -w '%{http_code}\n' \
  https://meleys.tail5586d4.ts.net/monitor/fleet
```

Then open `/fleet` on the production portal signed in as an allowlisted admin.
The chart needs two readings per host before it can draw a line, so give the
collector a minute after first boot.

The play history backfill runs in the same collector on its own clock. On a
fresh database it pages a year of history from every server first (a few
thousand rows per server, well under a minute) and then takes a full library
inventory (tens of thousands of items on meleys, several minutes). Until the
first history pass lands, `/plays` says the collector is backfilling; until the
inventory lands, never-played counts nothing. Watch it arrive with:

```bash
sudo docker compose logs -f fleet-collector | grep plex
curl -s -o /dev/null -w '%{http_code}\n' \
  https://meleys.tail5586d4.ts.net/monitor/plays/sync   # 401 without a session
```

## When the chart is empty

| Symptom                                                            | Cause                                                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Expected JSON from /fleet ... Is VITE_FLEET_BASE set?`            | Unset in Netlify, or set but not redeployed. The call went to the SPA's own `/fleet` route and got index.html.                                                             |
| The CPU chart works but Memory, GPU and Network report a failure   | The NAS is running a monitor from before those routes existed. Netlify redeploys from `main` on its own and the NAS does not, so `bun run deploy:nas` is the missing step. |
| The GPU chart draws two flat lines at 13.3%                        | Correct, and not a fault. That is the i915 idle floor (100 MHz of a 750 MHz ceiling) on the only two boxes with a render node; the line moves when something transcodes.   |
| `Not signed in, or this account is not allowed to read the fleet.` | Session lapsed, or the email is missing from `FM_ADMIN_ALLOWED_EMAILS`. Check the container's env, not just the file.                                                      |
| Cards render, chart legend lists hosts with no lines               | Collector is not reaching those hosts. Its ssh key is missing from their `authorized_keys`.                                                                                |
| Everything reads as down, browser console shows a CORS error       | The Funnel mount is missing, so the request never reached the monitor.                                                                                                     |
| `/fleet` broken _and_ invites stopped going out                    | Someone ran `tailscale serve` instead of `funnel`. The node is tailnet-only; re-run the step 4 command.                                                                    |
| `/plays` reports every server unreachable with `no_token`          | Neither `FM_PLEX_TOKEN` nor `PLEX_TOKEN` reached the collector container. Check `docker compose exec fleet-collector env`, not just the file.                              |
| `/plays` shows vermithor or vhagar unreachable with `refused`      | Those two refuse plain http. The url in `config.py` must be `https://` for them; a PMS setting change to "secure connections: required" on another box needs the same.     |
| `/plays` never-played lists nothing while plays are counted        | The inventory pass has not completed yet, or one section failed mid-page and the run retired nothing. `/plays/sync` shows `library_synced_at` per server.                  |
