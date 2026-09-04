---
name: member-triage
description: Use when one wizteros member has an access, invite, or billing problem that needs diagnosing before anything is changed. Triggers include "X paid but can't watch", "resend the invite for Y", "why was Z disabled", "member says they were charged", "look up member X", "did their renewal go through", or a forwarded support message about a single member. Only applies to the wizteros repo.
---

# Member triage

## Overview

The support runbook for one person. Gather what Stripe, Wizarr, the bridge store, and
the bridge logs each say about a single email, then map the symptom to one cause and one
remedy.

`apps/stripe-bridge/stripe_bridge/admin.py` already has every verb (reissue-invite,
reset-expiry, reset-tier, set-tag, set-downloads, cancel-subscription). This skill is the
judgment layer that decides which one applies, and whether any of them should be pressed
at all.

**Nothing here mutates a member.** The gather script is read-only, and every admin verb
sits behind a Supabase session JWT plus an email allowlist (`require_admin`), which no
CLI can mint. Actions happen in the admin web UI, pressed by a human.

## Running it

```bash
node --env-file=.env .claude/skills/member-triage/scripts/gather-member.mjs member@example.com
```

Run it from the repo root. **`.env` is gitignored, not absent**: only `.env.example` is
committed, so whether a real `.env` exists is a property of the working copy, not of the
repo. A checkout that has one (this is the usual case on the machine that runs the
bridge) works with `--env-file=.env` as above. A fresh clone has none, and `--env-file`
pointed at a missing file dies with `node: .env: not found` (exit 9) before a line of the
script runs — there point `--env-file` at whatever file holds the values locally
(`.env.local` is also gitignored), or export them for the command instead.

It needs `STRIPE_API_KEY`, `WIZARR_BASE_URL`, and `WIZARR_API_KEY` (the same three the
bridge runs with), plus SSH key auth to the NAS and `sudo -n docker` there for the store
and log sections.

Config is a precondition, not a degradable section: any of those three missing or empty
exits 2 with `Missing STRIPE_API_KEY / WIZARR_BASE_URL / WIZARR_API_KEY` and prints no
dossier at all. What degrades is a reachable-but-failing upstream: it prints
`unavailable: <reason>` and every other section still prints. A bad Stripe key leaves you
the Wizarr, store, and log sections; being off the LAN leaves you Stripe and Wizarr.

`WZ_LOG_TAIL` (default 2000) widens the log window; `WZ_NAS_HOST` (default
`crivas@192.168.50.2`) points at another NAS.

## Reading the dossier

- **Stripe** is the payment truth. `status=active` with a `paid` latest invoice means
  they are current. `status=canceled` with `ended` in the past means whatever disabled
  them was legitimate.
- **Wizarr** is the access truth, one record per server. `GET /api/users` returns only
  `id, username, email, server, server_type, expires, created_at`, so there is no enabled
  flag to read. For Plex a disable is `removeFriend()` on plex.tv, account wide because
  there is no per-server unshare; the call itself leaves the record alone, but Wizarr's
  next user sync deletes every row plex.tv no longer reports as shared, so the record
  goes away on its own. So no records means no access, and a record with a past `expires`
  means a lapsed window. The user list is cached for ten minutes, so a record disabled
  seconds ago can still show. An invitation still `pending` with `used_by=nobody` is
  not proof the member never opened it: a redemption Plex rejected leaves the
  invitation unconsumed and shows only in Wizarr's own container log (case 9).
- **Bridge store** is the bridge's memory. `tier` drives the displayed tier, the
  downloads default, and the scope of the _next_ invite. `subscribed` is the
  confirmed-payment flag written by the webhooks, and status keys off it, not off the
  expiry. `invited_at` starts the grace clock. `invite_code` is the last invite issued.
  Events are the audit trail.
- **Bridge logs** are the why. Member lines carry the email; the alarm pass catches the
  ones that do not (tier scope, unresolved tiers, tracebacks).

Status vocabulary (`apps/admin-portal/src/lib/memberStatus.ts`): **VIP** beats everything
(the `hvu` tag changes nothing); **Payment Failed** is `payment_state = past_due`, a
Stripe charge failing right now on a member who still holds access; **Subscribed Monthly**
and **Expired Member** are gated on `subscribed`, never on the presence of an expiry, and
split on whether that expiry is past; **Invited** and **Declined Invite** are `invited_at`
inside or past the 14 day grace (`INVITE_GRACE_DAYS` in `lib/inviteRules.ts`);
**Uninvited** is known to the bridge with no payment and no invite.

`servers` and `libraries` on a member payload are what they can actually watch (Wizarr
records unioned with the live plex.tv share); `entitled` is what their tier _would_ grant.
A row reading `—` under Servers/Libs holds nothing, whatever its tier says.

A **Stripe email** row on the member page (and `pays as <address>` on `/manage`) means
they check out under one address and watch under another. That is a normal household
shape, not an error: `email` is the Plex account, `stripe_email` is the card. The two are
joined through the invite they redeemed (`used_by`), so the join only exists once a
**bridge-issued** invite has been redeemed. An invite created straight against the Wizarr
API links nothing.

A **possible duplicate** badge is the weaker signal: another member's address is one edit
away, or the same Gmail mailbox written with dots or a `+tag`, and nothing proves they are
the same person. That is usually one person with two Stripe customers. Check both in
Stripe before concluding anything about either, and never assume the older or
better-looking address is the one holding the money.

The grace is 14 days but the deployed bridge runs `INVITE_EXPIRES_DAYS=7`, so a member can
read **Invited** for a week after their link stopped working. Trust the invitation's
`status`, not the badge.

## Case 1: paid but never invited

**Dossier.** Stripe: active subscription, paid invoice. Wizarr: records `none found`,
invitations `none found`. Store: no `customer_map` row, or a row with `invite=none`.

**Which cause, from the logs:**

- No `stripe event: checkout.session.completed` near the payment time. The webhook never
  arrived. Confirm in the Stripe dashboard under the endpoint's delivery attempts
  (Funnel down, or a signature mismatch answering 400).
- `no libraries resolved for <tier> tier checkout <id>; aborting for retry`, usually next
  to `tier scope check:` alarms. The handler raises deliberately so the event stays
  unmarked and Stripe keeps retrying. Fix the scope (case 4) and the retry completes on
  its own.
- `no email on session <id>`. Nothing can be issued automatically; get the address from
  the Stripe dashboard.

**Remedy.** Once the cause is cleared: admin UI `/user`, **Invite**, pick the tier they
paid for (`POST /admin/reissue-invite`). That creates the scoped invite, writes the
pending store row, and mails the link.

Do not treat a Stripe event resend as the fix. A delivery that already succeeded is in
`processed_events` and a resend logs `skipping already-processed event` and does nothing.
Resending only helps when the first attempt failed.

## Case 2: invite email never arrived

First separate "no invite exists" (that is case 1) from "invite exists, mail did not
land". Invite exists looks like: store `invite=<code>` with a recent `invited_at`, and
Wizarr invitations showing that code as `status=pending`.

- **Mail went out** (`sent invite to <email>` in the logs). Their delivery problem: spam
  folder, wrong address. Resend the same link by hand. Do not reissue, the existing
  invitation is still redeemable.
- **Mail failed** (`invite email to <email> failed` plus a traceback; the reissue
  returned `emailed: false`; the store event reads "Invite issued / email failed, link
  sent manually"). The invite is valid. Send `{PUBLIC_INVITE_BASE}/j/<code>` manually.
  On the checkout path an SMTP failure raises before the event is marked, so Stripe
  retries, reuses the same code from `session_invites`, and only re-attempts the mail
  while `emailed` is still 0. One checkout never produces two invites.
- **Link expired** (`status=expired`, or `invited_at` older than the link window). Only
  then issue a fresh one from `/user`, **Invite**.

SMTP itself: `apps/stripe-bridge/stripe_bridge/mailer.py` reads `SMTP_HOST`, `SMTP_USER`,
and `SMTP_PASS` as required env at import (`SMTP_PORT` defaults to 587) and does STARTTLS
plus login on every send. A missing one stops the container booting at all, so a running
bridge with failing mail means bad credentials, a blocked port, or the provider rejecting
the from address. Fix `.env` on the NAS and rebuild (deploy-nas skill).

The link window is `INVITE_EXPIRES_DAYS`: the code default is 14, `.env.example` ships 7,
and the deployed bridge is running 7, so read the live value instead of assuming.

## Case 3: disabled but believes they paid

Expect Wizarr `records: none found`. There is no "disabled" record to look at.

- **Canceled.** Store event "Canceled", log `disabled N record(s) for <email>`,
  `subscribed=0`, Stripe `status=canceled`. The system did the right thing. If they deny
  cancelling, check the latest invoice: a subscription ended by an unpaid invoice looks
  identical from Wizarr's side.
- **Re-scoped and never re-joined.** A recent store event "Invite issued", an invitation
  still `pending`, `subscribed=1`. A tier change that dropped one of their servers forces
  disable-first, because Wizarr has no per-server unshare. They are mid-migration, not
  disabled. Resend the pending link. Only the checkout path logs this (`reset N existing
record(s) for <email> pending re-join`); an admin reissue disables silently and reports
  the count as `disabled: N` in its own response, so the store event is the evidence, not
  the log.
- **Window lapsed.** That shows up as a record with a past `expires`, not as a missing
  record. See case 5.

**Remedy when Stripe says they are current.** `/user`, **Invite** with their paid tier
(`POST /admin/reissue-invite`); they re-join through the link and the share comes back.
Set expiry cannot help here: `reset-expiry` 404s with "no member for that email" when
there are no Wizarr records to write to.

**Remedy when Stripe says canceled.** There is nothing to fix. They re-subscribe through
the payment link. Never re-grant access to a canceled subscription on your own judgment.

## Case 4: wrong tier or wrong library set

Two different failures with two different remedies. Do not mix them.

**(a) The recorded tier is wrong.** Store `tier` disagrees with what they bought. Usual
cause is a Payment Link with no `metadata.tier`: `normalize_tier` logs `unknown tier ...
defaulting to bronze` and the member silently lands on bronze. Legacy `kids` maps to
`youth` and is not a bug.

- Record only: `/user`, **Hard reset tier** (`POST /admin/reset-tier`). Rewrites the
  displayed tier, the downloads default, and the scope of their _next_ invite. It does
  not touch their current Plex share.
- Actual access: `/user`, **Invite** with the right tier (`POST /admin/reissue-invite`),
  and the member must open the link. Redemption is where the share is re-scoped in place.
- Durable fix: add `metadata.tier` to the Payment Link in the Stripe dashboard, or the
  next buyer lands on bronze too.

**(b) The library set is wrong for the tier.** This is the tier-scope alarm pattern and
it is never a per-member problem. The dossier's alarm pass shows `tier scope check:
<tier> -> ...` or `youth allowlist mismatch on Meleys; missing [...]`.
`apps/stripe-bridge/stripe_bridge/tiers.py` matches Plex library **names**: youth is a
three-name allowlist, bronze is everything without "4k" in the name, silver and gold take
everything, only libraries Wizarr reports as `enabled` count, and every tier is filtered
to `SHARE_SERVER` (Meleys) with `9X.` libraries stripped last and independently.

Point at the tier definitions, not the member. Rename back on Plex or update `tiers.py`,
then `bun run refresh:libraries`, `bun run test:bridge`, deploy, and only then reissue
the affected members. An invite already carries the library ids it was created with and
will not improve on its own.

**Downloads** are an override, not an access change: `/user`'s toggle
(`POST /admin/set-downloads`) changes the displayed value now and only takes effect on
Plex at the next reissued invite, because Wizarr has no per-user downloads endpoint.

## Case 5: renewal did not extend the expiry

Expected behaviour: any `invoice.paid` except the signup one sets every record's expiry to
now plus `ACCESS_DURATION` (35 days), absolutely, not additively, and logs `renewed N
record(s) for <email>`. The handler skips exactly `billing_reason=subscription_create`, so
a `subscription_update` or a one-off invoice renews too.

- `payment for <email> found no records; reissued <tier> invite <code>`: there was nothing
  to extend, so the bridge issued a fresh invite and mailed it rather than leaving them
  locked out. Their records are gone, or the payment arrived on a second Stripe customer.
  That is case 7, and the remedy has already run.
- VIP: the log says VIP and the event reads "Payment received". Expiry is deliberately
  untouched. Not a bug, do not correct it.
- `skipping first (signup) invoice`: by design. The checkout already stamped the window.
- **No expiry at all** on a subscribed member: the hourly reconcile sweep stamps
  `invited_at` plus 35 days and logs `reconcile: stamped expiry ...`. Wait one
  `RECONCILE_INTERVAL_SECONDS` (3600, unset on the NAS so the default holds) before
  touching anything. A missing expiry usually heals itself; a wrong one never does. It
  will not heal for a VIP, for a member with no `invited_at`, or when `invited_at` plus 35
  days is already past, which logs `reconcile: computed expiry ... is already past;
skipping` rather than letting a background job revoke anyone. Those are the ones that
  need Set expiry.

**Remedy.** `/user`, **Set expiry** to the paid date plus 35 days
(`POST /admin/reset-expiry` with an absolute `expires_at`). Then fix the cause: correct
the customer's email in the Stripe dashboard so the next `invoice.paid` resolves, or
reissue an invite so the store row and the Plex account line up. Setting the expiry alone
buys 35 days and nothing else.

## Case 6: charge failed, member still has access

Dossier: Stripe `status=past_due` with `delinquent=true` and a latest invoice still
`open`; store `payment_state=past_due`, `subscribed` still 1; Wizarr records present with
an expiry that has not yet passed. The UI reads **🟠 Payment Failed**.

Nothing is broken. Stripe retries a declined charge for weeks and the member keeps the
period they paid for, so the bridge deliberately leaves access alone. What matters is the
deadline: **their expiry is not extended until an invoice is actually paid**, so if the
retries never succeed, the window runs out and Wizarr expires their records away. That is
how a member ends up locked out with a live-looking subscription.

- **Remedy:** none in the admin UI. Tell the member their card is failing and point them
  at the billing portal to update it. Do not extend the expiry to paper over it, and do
  not cancel on their behalf.
- **Watch the date.** If the expiry lands before Stripe gives up, they will lose access
  mid-dunning. `POST /admin/reset-expiry` is the one legitimate use of Set expiry here,
  and only to hold them to the end of the period they already paid for.
- **If the retry succeeds**, `invoice.paid` clears the flag and extends the expiry on its
  own. If their records are already gone by then, the bridge issues a fresh invite and
  mails it (an **Access restored** event, plus an operator alert). Check for a second
  Stripe customer before assuming that invite is the whole fix.

## Case 7: paid, and the payment found nothing to extend

Dossier: Stripe shows a paid invoice; the member history carries **Access restored**; an
operator alert went out; Wizarr records still `none found` until they redeem.

The bridge already did the remedy. Do not reissue again on top of it, that only repoints
the store row at a newer code and restarts the grace clock. Two causes to separate:

- **Their window lapsed while an earlier invoice went unpaid** (case 6 that ran out of
  road). The reissued invite is the fix; they need to open it.
- **The payment landed on a second Stripe customer.** Look for a "possible duplicate"
  badge, or search Stripe by the near-miss address. Both subscriptions are billing one
  person and only one of them will keep working. Cancel the one they do not want (case 8)
  and, if the failed one was charged, refund it in the Stripe dashboard.

## Case 8: member wants to cancel

Only on the member's own request.

`/user`, **Cancel subscription** (`POST /admin/cancel-subscription`). It flags every live
subscription `cancel_at_period_end` and revokes nothing now: they keep the period they
contributed for, then Stripe fires `customer.subscription.deleted` and the webhook
disables the records. Idempotent, so a second press is safe and already-flagged
subscriptions still count as scheduled.

Two 404s to expect: "no stripe customer for that email" (no mapping and no Stripe
customer at that address, so check for a second address) and "no active subscription for
that email".

The Stripe dashboard and the customer portal do the same thing, but only the admin UI
writes the "Cancellation scheduled" event into the member's history, so prefer the UI.
Cancel is never immediate here, and there is no revoke-now button to reach for: the admin
API has no disable or delete verb at all, so pulling access early means doing it in Wizarr
by hand, outside the event log.

## Case 9: redeemed, but Plex rejected the share

Dossier: Stripe active with a paid invoice. Store `subscribed=1`, `invite=<code>`, event
"Signed up". Wizarr invitation `status=pending`, `used_by=nobody`, records `none found`.
Bridge log `sent invite to <email>` and nothing after it. It looks exactly like a member
who never opened the link, so the member's own report is the only signal the dossier
does not carry.

The bridge plays no part in redemption, so the evidence is in Wizarr's container log:

```bash
ssh crivas@192.168.50.2 'sudo -n /usr/local/bin/docker logs --tail 4000 wizarr 2>&1' \
  | grep -i "invitation failed\|Failed to invite"
```

`Failed to invite friend <email>: '33. formula 1'` beside
`"event": "Plex invitation failed", "code": "<code>"` means Wizarr handed plexapi a
library name the live server does not have. Wizarr shares by name, from its own
`library` table, and that table only refreshes when someone presses **Scan libraries**,
so a rename on the Plex side leaves the old name in the cache and Plex rejects the whole
share. The invitation stays `pending`, so the member can retry the same link once the
cache is right.

This is never a per-member problem: every pending invite scoped to that server carries
the same stale row, the baseline links included. On 2026-09-04 it was "33. Formula 1"
renamed to "22. Formula 1" on Meleys, and it broke every bronze, silver and gold invite
at once while the tier scope check stayed green, because that check reads the same
cache.

**Remedy.** Rescan the server's libraries in Wizarr (Settings, Media Servers, the
server, **Scan libraries**). The scan upserts by Plex section id and keeps each row's
primary key, so every pending invite is repaired in place and needs no reissue; the
member opens the same link again. The scan routes are session-only, so with no Wizarr
admin login at hand `scripts/rescan-wizarr-libraries.py` performs the same upsert from
inside the container (it writes to Wizarr's database, so snapshot first with the
nas-state-backup skill). Confirm with `GET /api/libraries`: the renamed row now carries
the live name. Do not reissue: a reissue before the rescan mints another invite with the
same stale row.

The bridge now checks Wizarr's cache against plex.tv's live sections on every invite
path and in the hourly scope check. `tier scope check: wizarr cache on <server> -> ...`
in the bridge log (the dossier's alarm pass shows it, and an alert mail goes out) names
the stale row, and the checkout, reissue and baseline paths drop it from the scope so the
invite still grants everything else. That alarm still means "rescan in Wizarr": the
dropped library only comes back on the next invite after the rescan.

## Where each remedy happens

| Remedy                                                                      | Where                                                                                  | Endpoint behind it                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| Issue or reissue a tier-scoped invite                                       | `/user` **Invite / Re-invite**, or `/reset-user` tier buttons                          | `POST /admin/reissue-invite`      |
| Set or clear an expiry                                                      | `/user` **Set expiry** / **Never expire**                                              | `POST /admin/reset-expiry`        |
| Correct the recorded tier only                                              | `/user` **Hard reset tier**                                                            | `POST /admin/reset-tier`          |
| VIP / HVU label                                                             | `/user` **Tag**                                                                        | `POST /admin/set-tag`             |
| Downloads override                                                          | `/user` downloads toggle                                                               | `POST /admin/set-downloads`       |
| Schedule a cancel at period end                                             | `/user` **Cancel subscription**                                                        | `POST /admin/cancel-subscription` |
| Confirm webhook delivery, fix a customer email, add `metadata.tier`, refund | Stripe dashboard                                                                       | none                              |
| Delete a stale invitation, inspect a record                                 | Wizarr API with `X-API-Key`, or the Wizarr UI                                          | `/api/invitations`, `/api/users`  |
| Fix a tier's library set                                                    | `tiers.py` plus the Plex library names, then deploy                                    | none                              |
| Refresh Wizarr's library-name cache after a Plex rename                     | Wizarr UI, Media Servers, **Scan libraries** (or `scripts/rescan-wizarr-libraries.py`) | none (session-only route)         |

## Reporting back

Lead with the diagnosis in one line, then the two or three dossier facts that prove it,
then the single remedy and who presses it. Name the endpoint behind the button so the
action is auditable afterwards.

If the cause is systemic (tier scope drift, a Payment Link missing `metadata.tier`, SMTP
credentials), say so plainly: fixing this one member leaves the next one broken.

If a section came back `unavailable`, say which one and how that narrows the conclusion.
A missing log section in particular means "cause not established", not "no cause".

## Red flags

- Never mutate a member from the CLI, and never as a favour while "just looking".
  Gathering is read-only; every change is a human pressing a button in the admin UI.
- Disabling or cancelling is always a human decision. Never infer a cancel from a support
  message, and never revoke access to settle an argument.
- Tier-scope alarm in the dossier: point at the tier definitions. Hand-editing one member
  around a broken tier hides the breakage from every future signup.
- Reissuing "just to be safe" is not free. It repoints the store row at a new code and
  restarts the grace clock, and if the new tier leaves one of their current servers
  uncovered, disable-first runs and they lose access until they redeem.
- Never edit `bridge.db` by hand. Every field it holds has an endpoint that also writes
  the event log.
- A `pending` invitation is not evidence the member never tried. Read Wizarr's container
  log before concluding a new signup simply has not clicked yet.
- "Never expire" is not a fix for a billing problem. Status is driven by `subscribed`, so
  clearing an expiry hides an unpaid member instead of resolving them.
- Two Stripe customers on one address is a real state, not a glitch. Read the whole
  Stripe section before concluding they never paid.
