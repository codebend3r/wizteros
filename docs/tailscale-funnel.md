# Public ingress with Tailscale Funnel

How the wizteros stack on Meleys is reached from the public internet — by
**Stripe** (webhooks) and by **members** (Wizarr invites/sign-in) — with no
custom domain, no port forwarding, and free TLS.

Tailscale Funnel replaces the earlier Cloudflare Tunnel plan, which needed a
domain we don't have.

## Why this shape

- Funnel only allows public ports `443`, `8443`, `10000`. We use **443 only** —
  Stripe webhook endpoints on non-standard ports are unreliable.
- Both services share one hostname via `--set-path` mount points. Tailscale
  **strips the mount prefix** before forwarding, so a request to
  `/stripe/webhook` reaches the bridge as `/webhook`. The bridge answers at
  **both** `/stripe/webhook` and `/webhook`, so direct/local calls and
  Funnel-proxied calls both land on the same handler.

```
 Stripe  ─┐
 Members ─┴─► https://meleys.<tailnet>.ts.net   (Funnel, 443, real TLS)
                 /               → 127.0.0.1:5690   wizarr
                 /stripe/webhook → 127.0.0.1:8000   stripe-bridge
              (Tailscale runs on the Meleys host; compose publishes 5690 + 8000)
```

> Substitute `<tailnet>` with your tailnet's MagicDNS suffix (shown in the
> Tailscale admin console, e.g. `tail1234.ts.net`). Full node name appears in
> `tailscale status` / `tailscale funnel status`.

---

## Phase 1 — Tailscale account + tailnet settings (browser)

1. Create a free account at <https://login.tailscale.com> (Personal plan; sign
   in with Google/GitHub).
2. Admin console → **DNS** → enable **MagicDNS** and **HTTPS Certificates**.
3. Enable **Funnel** for the tailnet. The first `tailscale funnel` command
   (Phase 3) prints a one-click URL to turn it on; or add a `nodeAttrs` entry
   granting `funnel` in the ACL editor.

## Phase 2 — Install Tailscale on Meleys

1. DSM → _Package Center_ → search **Tailscale** → Install. (If absent, download
   the `.spk` for your NAS CPU arch from <https://pkgs.tailscale.com/stable/#synology>
   and use _Manual Install_.)
2. Open the Tailscale package → **Log in** → authorize the node. Meleys gets a
   MagicDNS name like `meleys.<tailnet>.ts.net`.
3. Confirm from SSH:
   ```sh
   tailscale status        # Meleys should be listed, logged in
   ```

## Phase 3 — Expose the two services (SSH, one-time)

```sh
sudo tailscale funnel --bg --set-path=/ http://127.0.0.1:5690         # Wizarr at root
sudo tailscale funnel --bg --set-path=/stripe http://127.0.0.1:8000   # bridge under /stripe
sudo tailscale funnel status                                          # prints the public URLs
```

Longest-prefix match sends `/stripe/...` to the bridge and everything else to
Wizarr. Tailscale strips the `/stripe` prefix, so the bridge receives
`/webhook` — which it also serves (see `stripe_bridge/stripe_wizarr_bridge.py`), so no
funnel-side path juggling is needed. Verify:

```sh
curl -s https://meleys.<tailnet>.ts.net/stripe/webhook -X POST -d '{}'
# expect the bridge's own response (400 "invalid signature"), NOT a 404.
```

- **Bridge responds (400)** → the path maps through correctly. Done.
- **404 from the bridge** → the bridge image predates the dual-path route;
  rebuild it (`sudo docker compose up -d --build stripe-bridge`) and re-test.
  The public Stripe URL stays `.../stripe/webhook` either way.

To change a mount later: re-run with the new target. To tear down: `sudo
tailscale funnel --set-path=/stripe off` (and `/`).

## Phase 4 — Point everything at the public URL

- **Wizarr** → Settings → set the external/public URL to
  `https://meleys.<tailnet>.ts.net`.
- **`.env`** (`/volume1/docker/stripe-bridge/.env`) →
  `PUBLIC_INVITE_BASE=https://meleys.<tailnet>.ts.net`, then
  `sudo docker compose up -d stripe-bridge`.
- **Netlify** (Westeroz site) → env var
  `VITE_MEMBER_URL=https://meleys.<tailnet>.ts.net` → redeploy (reveals the
  member sign-in link).
- **Stripe** → Developers → Webhooks → endpoint
  `https://meleys.<tailnet>.ts.net/stripe/webhook`, events
  `checkout.session.completed` + `customer.subscription.deleted`. Copy the
  signing secret into `.env` (`STRIPE_WEBHOOK_SECRET=`) and
  `sudo docker compose up -d stripe-bridge`.

## Phase 5 — Test end-to-end (Stripe test mode)

> Production has been on live keys since 2026-07-22. This phase is still the
> right rehearsal for config changes: switch the bridge to the TEST block in
> `.env` first, then trigger the events below with the Stripe CLI.

```sh
curl -I https://meleys.<tailnet>.ts.net/        # Wizarr loads publicly (200)
stripe trigger checkout.session.completed
stripe trigger customer.subscription.deleted
# watch the bridge act on them:
sudo docker compose logs -f stripe-bridge
```

---

## Notes

- The public hostname is `meleys.<tailnet>.ts.net` — free, real HTTPS, but long
  and not brandable. Members see a `.ts.net` link in their invite. The only way
  to a pretty name is a custom domain, which nothing in the payment flow
  requires.
- Funnel state lives on the Meleys host, not in the compose file, so it survives
  `docker compose down`. `cloudflared` was removed from `docker-compose.yml`.
- Keep `STRIPE_API_KEY` on the **test** key until the full flow is verified; the
  live-key switch is a separate later step.
