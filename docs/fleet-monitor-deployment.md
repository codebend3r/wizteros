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
`/fleet/memory`, `/fleet/gpu`, `/fleet/network`) and `/incidents` all
require `Authorization: Bearer <supabase jwt>` whose ES256 signature verifies
against the project's published keys and whose email is in
`FM_ADMIN_ALLOWED_EMAILS`. Unset config rejects rather than passes: a
half-configured container is shut, not open.

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
```

Same values the bridge's `SUPABASE_URL` and `ADMIN_ALLOWED_EMAILS` hold. They
are named apart because each service reads its own env.

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
