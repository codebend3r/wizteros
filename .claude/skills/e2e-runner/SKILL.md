---
name: e2e-runner
description: Use when the wizteros live end-to-end suites are in play, either running them or deciding whether they should be run at all. Triggers include "run the e2e tests", "retest the flow", "verify tiers against live wizarr", "is the invite flow still working", "e2e the bridge before deploy", a pending bridge change to webhook handling, tier scoping, or expiry math, and the aftermath of a Wizarr upgrade. Only applies to the wizteros repo.
---

# Run the live e2e suites

## Overview

Two Node scripts drive **synthetic, locally signed Stripe webhooks** through a **locally
running bridge container** against the **live Wizarr instance**:

| Script | Nx target (root alias) | Proves |
|---|---|---|
| `apps/stripe-bridge/scripts/e2e-retest.mjs` | `stripe-bridge:test:e2e` (`bun run test:e2e`) | The paid-access flow time-boxes a real member's records |
| `apps/stripe-bridge/scripts/e2e-tiers.mjs` | `stripe-bridge:test:e2e:tiers` (`bun run test:e2e:tiers`) | Each tier's signup produces a correctly scoped invite |

Both targets are **inferred** from the `scripts` in `apps/stripe-bridge/package.json`
(whitelisted by its `nx.includedScripts`), not declared in `apps/stripe-bridge/project.json`,
which holds only the Docker targets (`docker-build`, `serve`, `stop`, `logs`, `test-docker`).
Reading `project.json` alone makes these look missing; they are not.

Nothing touches Stripe. Both scripts build the event JSON themselves and sign it with
`HMAC-SHA256(STRIPE_WEBHOOK_SECRET, "<ts>.<payload>")`, exactly the way Stripe does, then
POST it to `http://localhost:8000/stripe/webhook`. The webhook never leaves the machine.
Both events carry a synthetic `cus_e2e...` id, but each also carries the member's email inline
(`customer_details.email` on the checkout, `customer_email` on the invoice), so the bridge never
falls back to `customer_email()` and `stripe.Customer.retrieve` is never called either.

Wizarr, on the other hand, is the real one. Every read and every write in these runs lands
on the production instance at `WIZARR_BASE_URL`, on the same records live members hold.
Treat these as production-touching, not as tests.

The container is `stripe-bridge-e2e` on port 8000, started from the repo-root `.env` with
`apps/stripe-bridge/data` bind-mounted at `/data`. That bind mount is why the bridge SQLite used
by an e2e run is a **local** file (`apps/stripe-bridge/data/bridge.db`, via `MAP_DB_PATH`'s
`/data/bridge.db` default), not the NAS one. The `serve` target pins `cwd: {workspaceRoot}`, so
the mount and the `--env-file .env` are always the repo's own, whichever directory you launch
from.

## What `test:e2e` actually does

`node --env-file=../../.env scripts/e2e-retest.mjs [email]`, run by Nx with the cwd set to
`apps/stripe-bridge`, so `../../.env` resolves to the repo-root file. Default member
`codebenderinc@gmail.com`, overridable as `process.argv[2]`, though the `bun run test:e2e` alias
cannot pass that argument (see Procedure).

1. Exits `2` unless `WIZARR_BASE_URL`, `WIZARR_API_KEY`, and `STRIPE_WEBHOOK_SECRET` are set.
2. Waits for the bridge: `GET /stripe/webhook` until it answers **405** (20 tries, 1s apart),
   otherwise fails with "bridge not reachable".
3. Reads the member's records straight from Wizarr (`GET /api/users?email=...`). A non-ok
   response aborts; **zero records aborts** ("no Wizarr records for ...").
4. **Reset to baseline**, per record: `POST /api/users/<id>/enable` (the response is *not*
   checked, so a failed enable is silent), then `PUT /api/users/<id>/update-expiry` with the
   body `{}`, which sets unlimited. A non-ok update-expiry aborts the run with the status and
   body. An explicit `null` is rejected by Wizarr's schema, hence the empty object.
5. **Checkout extension**: posts a signed `checkout.session.completed` with a fixed session id
   `cs_e2e`, a unique customer `cus_e2e_<ms>`, a unique event id, `customer_details.email` set
   to the member, and **no `metadata.tier`**. The bridge therefore logs an `unknown tier` error
   and normalizes to **bronze**. A non-2xx response aborts with the status and body.
6. **Renewal extension**: posts a signed `invoice.paid` with
   `billing_reason: "subscription_cycle"` and `customer_email` set to the member. Same abort rule.
7. **The expiry math assertion**, the only true assertion in the file. It re-reads the records
   and fails any record where `expires` is falsy, or where
   `|expires - (assert_time + ACCESS_DURATION days)| > 2 days`. `ACCESS_DURATION` defaults to
   `35`. Failures print and exit `1`; otherwise "PASS: all N server record(s) expire
   ~now + 35 days".

Because event ids are unique per run, the `processed_events` idempotency table never skips a
run. Because the customer id is unique per run, no stored mapping is reused.

Bridge surface this covers: signature verification, the checkout handler (tier normalize, live
library resolution, invite create *or* reuse depending on whether `cs_e2e` is already bound,
invite email, `upsert_pending`, the `stale_record_ids` coverage check, expiry stamp on surviving
records), and the `invoice.paid` handler (`set_subscribed`, id resolution by email, absolute
expiry).

Surface it does **not** cover: invite scoping (it never sends a tier), whether records end up
**enabled** (only `expires` is asserted), and `customer.subscription.deleted` entirely. It also
never reaches the branches a non-VIP member on the share server cannot trigger: both VIP short
circuits, the `billing_reason: "subscription_create"` skip, the invite-code fallback in
`resolve_user_ids` (the per-run customer id is unique, so there is no stored mapping to fall back
to), and the disable-first half of `stale_record_ids`, which fires only when a record sits on a
retired server.

> The two paid events do not stack. `set_expiry` writes an absolute date, so the checkout and the
> renewal both land on `now + ACCESS_DURATION` instead of adding up to `2*ACCESS_DURATION`, and
> that is what the assertion checks.

## What `test:e2e:tiers` actually does

`node --env-file=../../.env scripts/e2e-tiers.mjs`, same cwd. Same env guard and exit `2`, but
**no bridge readiness wait**: it reads `GET /api/libraries` and then posts straight at
`BRIDGE_URL`, so a container that is not up surfaces as a bare `ERROR: fetch failed`. Uses a
synthetic address `e2e-tiers-<ms>@invalid.test` that matches no Plex account, so
`find_users_by_email` returns nothing and the disable-first path can never reach a real member.

Per tier, in order `bronze, silver, gold, youth`:

1. Posts a signed `checkout.session.completed` with a **unique** session id, a unique customer,
   and `metadata: { tier }`. A non-ok response throws and ends the whole run.
2. Re-reads `GET /api/invitations` and takes the last code that was not present before the run.
   No new invite records the failure "`<tier>`: bridge created no invite" and moves on.
3. Asserts, hard: `invite.server_names` sorted and joined equals exactly `SHARE_SERVER`
   (env override, default **Meleys**).
4. Asserts, only when Wizarr actually returned `specific_libraries` ids (it usually returns
   `[]`, and the script says so): the resolved library names equal a JS-side mirror of the tier
   rules, computed independently of `tiers.py` so a bug in one is not mirrored by the other.
   The mirror is: enabled libraries whose `server_name` is the share server and whose name does
   not match `^9\d\.`, then youth is the allowlist `03. Family Movies`, `04. 4K Family Movies`,
   `14. Kid Shows`; bronze is everything without "4k" in the name; silver and gold are everything.
   Differences are reported as `missing:` and `unexpected:`.
5. Asserts, also only over returned ids: bronze was granted no 4K library, and no tier was
   granted a `9X.` private library.
6. **Downloads is printed, never asserted.** `EXPECT_DOWNLOADS` (`bronze:false, silver:false,
   gold:true, youth:true`) only appears in the `ok` line; the invite's real `allow_downloads` is
   never read back. Do not report the tiers suite as proof the downloads flag is right.
7. **Cleanup**: `DELETE /api/invitations/<id>` for every invite created, even when assertions
   failed, then "Cleaned up N test invite(s)". A failed delete prints `WARN could not delete
   invite <code>` and the run keeps going.

One thing the suite proves implicitly and loudly: a tier that resolves to zero libraries makes
the checkout handler raise, which surfaces as a 500 on the POST and aborts the run.

## What "live" means here

**`test:e2e` mutates a real member.** It enables and clears the expiry on every one of their
Wizarr records, then drives them back to `now + ACCESS_DURATION`. The end state is a member
holding a fresh 35 day window. It also, on the checkout, either leaves their records alone
(all records on Meleys, the covered case) or **disables every record they have** (any record on
a retired server, the `stale_record_ids` fail-closed fallback), which severs the plex.tv
friendship until they redeem an invite. The script never re-enables at the end and never
asserts enabled state, so a green run can leave a member disabled.

**It creates a real invite and can send a real email.** The session id `cs_e2e` is fixed, so the
first run against a fresh local `apps/stripe-bridge/data/bridge.db` creates a bronze invite for
that member and mails the link, then records the binding. Later runs reuse the bound code and send
nothing. **That first invite is never deleted by the script.** It stays redeemable in live
Wizarr until `INVITE_EXPIRES_DAYS` passes.

**`test:e2e:tiers` mutates no member.** It creates four invites and deletes them, and it mails
four invite links to the synthetic `@invalid.test` address through the real SMTP relay. Bounces
land in the `FROM_ADDR` mailbox. It does leave four synthetic subscribers behind in the local
bridge DB (`upsert_pending` marks every checkout subscribed), which is local-only noise.

**The container itself is live.** It boots with a live Stripe key, the live Wizarr key, and SMTP
credentials, published on `0.0.0.0:8000`. On boot and every `RECONCILE_INTERVAL_SECONDS`
(default 3600) it runs the tier scope check (which can **send an alert email** if a tier is not
resolving) and the expiry reconcile sweep, which stamps `invited_at + ACCESS_DURATION` on the
live records of any subscribed, non-VIP row in the local bridge DB whose records still carry no
expiry. Every e2e checkout writes such a row, `subscribed` included. A second loop reads live
Wizarr and plex.tv every `MEMBERS_SNAPSHOT_INTERVAL_SECONDS` (default 300) to refresh the members
snapshot. That is the real reason to always bring it down.

### Running retest against the default member

`codebenderinc@gmail.com` is the designated test member (the repo owner's own account). Running
against it is fine when the owner is running it on their own machine, is fine with one invite
email landing in that inbox, and expects the account to end on a fresh 35 day window.

Pass a different email only to reproduce a specific member's breakage, and only knowing that the
run **grants that member 35 days regardless of what they actually paid**, and may disable all of
their records. Never point it at a paying member you have not spoken to, and never use it as a
routine smoke test against someone else's account.

### If a run dies mid-way

| Left behind | How to tell | How to clean up |
|---|---|---|
| Member reset but not extended | Records enabled with `expires` null (unlimited access, no paid window) | Re-run the retest for that email (direct `node` invocation, see Procedure), or `PUT /api/users/<id>/update-expiry` with a real ISO date |
| Member disabled by the checkout path | Records disabled, invite created and mailed | `POST /api/users/<id>/enable` per record, then stamp expiry as above |
| Stranded retest invite | The `cs_e2e` bronze invite for the member's email, never deleted by design | Find it in `GET /api/invitations` and `DELETE /api/invitations/<id>`, or delete it in the Wizarr UI |
| Stranded tier invites | Up to four, when a throw escaped `main()` before or during the cleanup loop (the deletes run under a 60s timeout that can itself throw); codes are in the run output | `DELETE /api/invitations/<id>` for each |
| Silently stranded tier invite | A `WARN could not delete invite` line in an otherwise green run | Same delete, by the code in the WARN line |
| Stranded container | `docker ps --filter name=stripe-bridge-e2e` | `bun run bridge:down` (or `docker rm -f stripe-bridge-e2e`) |

With `WIZARR_BASE_URL` and `WIZARR_API_KEY` exported from `.env`:

```bash
curl -s -H "X-API-Key: $WIZARR_API_KEY" "$WIZARR_BASE_URL/api/invitations"
curl -s -X DELETE -H "X-API-Key: $WIZARR_API_KEY" "$WIZARR_BASE_URL/api/invitations/<id>"

curl -s -H "X-API-Key: $WIZARR_API_KEY" "$WIZARR_BASE_URL/api/users?email=<member>"
curl -s -X POST -H "X-API-Key: $WIZARR_API_KEY" "$WIZARR_BASE_URL/api/users/<id>/enable"
curl -s -X PUT -H "X-API-Key: $WIZARR_API_KEY" -H 'Content-Type: application/json' \
  -d '{"expires":"2026-09-11T00:00:00+00:00"}' \
  "$WIZARR_BASE_URL/api/users/<id>/update-expiry"
```

The local bridge DB also keeps rows from every run (`customer_map` marked subscribed,
`session_invites` for `cs_e2e`, `processed_events`). It is local state, not the NAS database, so
it is safe to leave. Deleting `apps/stripe-bridge/data/bridge.db` resets it, at the cost of the
next retest minting and mailing a fresh `cs_e2e` invite.

## Prerequisites

- **A complete `.env` at the repo root** (gitignored, never commit it). A fresh clone or a git
  worktree has only `.env.example`, so nothing runs until you put one there.
  - When the file is **missing entirely**, Node never gets as far as the guard: the target dies
    with `node: ../../.env: not found` and exit code **9** (Nx reports the task as failed).
  - Both scripts check exactly three vars and exit `2` otherwise: `WIZARR_BASE_URL`,
    `WIZARR_API_KEY`, `STRIPE_WEBHOOK_SECRET`.
  - The container hard-requires more at import time, via `os.environ[...]`:
    `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `WIZARR_BASE_URL`, `WIZARR_API_KEY`,
    `PUBLIC_INVITE_BASE` (`stripe_wizarr_bridge.py`) and `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
    (`mailer.py`). A missing one is a `KeyError` at import, so the container exits instantly and
    the script reports "bridge not reachable" rather than the real cause. Check `docker logs`.
  - Optional, with defaults: `ACCESS_DURATION` (35, read by both the script and the bridge),
    `INVITE_EXPIRES_DAYS` (14 in code, 7 in `.env.example`), `BRIDGE_URL`
    (`http://localhost:8000`), `SHARE_SERVER` (`Meleys`, tiers script only; `tiers.py` hardcodes
    its own `SHARE_SERVER` and ignores the env).
- **Docker running** and port 8000 free. Every `bun run ...` alias works from any directory in the
  repo: the Docker targets pin `cwd: {workspaceRoot}` (`bridge:up` bind-mounts
  `$PWD/apps/stripe-bridge/data`) and the inferred script targets always run from
  `apps/stripe-bridge`, which is what makes `--env-file=../../.env` land on the root `.env`. Only
  the hand-rolled `node --env-file=.env apps/...` form below is cwd-sensitive, and has to be run
  from the repo root.
- **LAN access to the live Wizarr**, from the host *and* from inside the container. The
  `.env` value is the NAS LAN address, so a full-tunnel VPN or a different network breaks both
  halves.
- **Node 20.6 or newer.** Both scripts run under `node --env-file`, not bun, even though they are
  invoked through `bun run`.

## Procedure

```bash
bun run retest            # bridge:build, bridge:up, test:e2e against the default member
bun run test:e2e:tiers    # tier scoping; needs the container already up
bun run bridge:down       # ALWAYS, pass or fail
```

- `retest` is `bun run bridge:build && bun run bridge:up && bun run test:e2e`, so it is the only
  entry point that rebuilds the image. **`test:e2e:tiers` builds and starts nothing**: run it right
  after a `retest` while the container is still up, or do
  `bun run bridge:build && bun run bridge:up && bun run test:e2e:tiers`.
- **Different member: the root alias cannot carry the email.** `bun run test:e2e someone@example.com`
  runs `nx run-many -t test:e2e -p stripe-bridge someone@example.com`, and `run-many` **silently
  drops** the positional: the script gets no `argv[2]` and retests `codebenderinc@gmail.com`
  instead of the address you typed. Use one of the two forms that do pass it, with the bridge
  already up:

  ```bash
  # from the repo root
  node --env-file=.env apps/stripe-bridge/scripts/e2e-retest.mjs someone@example.com
  # or through Nx (the second colon parses fine here; args after -- are forwarded)
  bunx nx run stripe-bridge:test:e2e -- someone@example.com
  ```

  Confirm the header line it prints (`E2E retest: someone@example.com`) names the member you
  meant before it gets past the bridge wait.
- `bridge:up` always `docker rm -f`s the old container first, so it is safe to re-run, but it
  runs whatever image `stripe-bridge` currently points at. After editing bridge code, rebuild.
- When something fails, read the bridge side: `bun run bridge:logs` is `docker logs -f` and
  **blocks forever**, so in a non-interactive session use
  `docker logs --tail 100 stripe-bridge-e2e`.
- Run both suites for a full picture. They cover different surfaces and neither implies the other.

## Reading failures

| Symptom | What broke, in product terms | Where to look |
|---|---|---|
| exit `9`, `node: ../../.env: not found` | There is no `.env` at all, so the run never started | Create the repo-root `.env` from `.env.example`; a fresh clone or worktree never has one |
| exit `2`, "Missing WIZARR_BASE_URL / ..." | The `.env` exists but is incomplete, so the run never started | Those three keys in the repo-root `.env` |
| "bridge not reachable at http://localhost:8000" (after ~20s) | The container is not serving; retest only, tiers has no such wait | `docker logs --tail 100 stripe-bridge-e2e`. Usually a `KeyError` at import from a missing env var, or port 8000 already taken |
| `ERROR: fetch failed` in tiers | Same cause, no friendly message: the container is down, or `WIZARR_BASE_URL` is unreachable from the host | `docker ps --filter name=stripe-bridge-e2e`, then the logs; then LAN access to Wizarr |
| `GET /api/libraries -> N` in tiers | Wizarr cannot list libraries, so no tier can be scoped or verified | `WIZARR_API_KEY`, then `WizarrClient.list_libraries` against the live API |
| `GET /api/users -> 401/403` | Wizarr rejects the key; nobody's access changed | `WIZARR_API_KEY` in `.env`, rotated by a Wizarr upgrade or reinstall |
| `GET /api/users -> 404`, or a read returns an unexpected shape | Wizarr's API surface moved under us | `stripe_bridge/wizarr.py`, then the scripts' direct `fetch` calls |
| "no Wizarr records for `<email>`" | That member has no records at all: deleted, or their Plex email differs | Confirm the member in Wizarr; pass the right email |
| `reset id=N -> 400` | The unlimited-expiry write was rejected | `WizarrClient.set_expiry`. Wizarr validates `expires` as a date-time, so clearing must omit the key. A schema change here breaks reset first |
| `POST checkout.session.completed -> 400: invalid signature` | The bridge would reject the real Stripe webhook too | `STRIPE_WEBHOOK_SECRET` mismatch between the script's `.env` and the container's env, usually a container started before the `.env` edit. `bridge:up` again |
| `POST ... -> 500` on retest | The checkout or renewal handler raised, so a real payment would retry forever | Logs first. Candidates: no libraries resolved for the tier (`tiers.resolve_tier_access`), a slow Wizarr write (`USER_WRITE_TIMEOUT`), SMTP failure in `mailer.send_invite_email` |
| `FAIL: N/M record(s) not set to ~now+35d`, `expires=null` | Paid access was not time-boxed: the member would keep unlimited access, or lose the paid window | `access_expiry_iso` and the `invoice.paid` branch in `stripe_wizarr_bridge.py`. Check whether the member is tagged `vip` in the local bridge DB: both handlers short-circuit for VIPs and leave expiry alone, which fails this assertion by design |
| `FAIL`, expiry present but outside the 2 day window | The window length drifted | `ACCESS_DURATION` in `.env` versus the container's env, then `access_expiry_iso` |
| `POST checkout(<tier>) -> 500` in tiers | That tier cannot issue an invite at all; real checkouts for it raise and Stripe retries forever | `tiers.py` against the live library names. This is the exact failure the tier scope alarm exists for. Also possible: the SMTP relay refused the `@invalid.test` recipient |
| "`<tier>`: bridge created no invite" | The webhook was accepted but no invite reached Wizarr | `WizarrClient.create_invite` and the `/api/invitations` response shape |
| "servers X != Meleys" | The invite was scoped to the wrong server, so a redeemer gets a retired server's copy or nothing | `tiers.SHARE_SERVER`, `_is_on_share_server`, and `resolve_tier_access["server_ids"]` |
| "missing: ..." / "unexpected: ..." | The tier rules and the real server disagree about library names | Compare `tiers.py` with the live list. If a Plex library was renamed, `bun run refresh:libraries` and fix `tiers.py` to match the new names, never the reverse. If `tiers.py` rules were changed deliberately, the script's independent mirror (`expectedNames`) is now stale and needs the same edit |
| "bronze granted a 4K library" / "granted a private 9X. library" | A scoping leak: paying members see libraries their tier does not include | `tiers._is_4k`, `_is_private`, `_shareable_libraries`. Highest severity on this list; stop and fix before anything ships |
| `WARN could not delete invite` | A redeemable test invite is loose in live Wizarr | Delete it by code (see the cleanup table) |

## When to run

- **Before deploying bridge changes** that touch webhook handling
  (`stripe_wizarr_bridge.py`), tier scoping (`tiers.py`), expiry math, or the Wizarr client
  (`wizarr.py`). Run both suites, then hand off to the **deploy-nas** skill. `bun run verify`
  (unit tests) is not a substitute: it proves the rules are self-consistent, not that they still
  match the real server.
- **After a Wizarr upgrade**, as the acceptance check for it. The suites exercise the exact
  endpoints the bridge depends on (`/api/users`, `/api/users/<id>/enable`,
  `/api/users/<id>/update-expiry`, `/api/invitations`, `/api/libraries`), which is where an
  upgrade breaks things.
- **After a Plex library rename**, alongside `bun run refresh:libraries` and `bun run test:bridge`.
- Not on a schedule, and not as a habit. Every retest run mutates a real member.

## Red flags

- **Pointing retest at a real member who is not the designated test member.** It resets and
  re-grants 35 days of access, and can disable every record they hold. Confirm the email first.
- **Assuming `bun run test:e2e <email>` retests that email.** The argument is dropped, so the run
  silently hits `codebenderinc@gmail.com` instead. Read the printed header, and use the direct
  `node` form for anyone else.
- **Leaving `stripe-bridge-e2e` up.** It holds live Stripe, Wizarr, and SMTP credentials on
  port 8000, and its reconcile loop keeps writing to live Wizarr on a timer. `bun run bridge:down`
  is part of the run, not an optional tidy-up.
- **Running against a stale image.** `bridge:up` without `bridge:build` tests the previous build,
  and a green result then means nothing about the change under review. Use `bun run retest`, which
  builds.
- **Treating a green tiers run as proof the webhook flow works.** It never renews, never expires,
  and never touches a real record. Equally, a green retest says nothing about tier scoping: it
  sends no tier and falls back to bronze.
- **Reading the tiers `downloads=` output as an assertion.** It is a printed constant.
- **Expecting the checkout and the renewal to stack.** `set_expiry` is absolute, so the assertion
  is `now + ACCESS_DURATION`, plus or minus 2 days, not `2*ACCESS_DURATION`.
- **A green retest on a member left disabled.** The suite asserts expiry only. Check enabled
  state before calling the flow healthy.
- **Editing a script to make a suite pass.** These two are the only checks that compare the code
  against the real server; a failure is a finding, not noise.
