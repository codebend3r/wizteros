---
name: member-triage
description: Use when one wizteros member has an access, invite, or billing problem that needs diagnosing before anything is changed. Triggers include "X paid but can't watch", "resend the invite for Y", "why was Z disabled", "member says they were charged", "look up member X", "did their renewal go through", or a forwarded support message about a single member. Only applies to the wizteros repo.
---

# Member triage

## Overview

The support runbook for one person. Gather what Stripe, Wizarr, the bridge store, and
the bridge logs each say about a single email, then map the symptom to one cause and one
remedy.

`admin.py` already has every verb (reissue-invite, reset-expiry, reset-tier, set-tag,
set-downloads, cancel-subscription). This skill is the judgment layer that decides which
one applies, and whether any of them should be pressed at all.

**Nothing here mutates a member.** The gather script is read-only, and every admin verb
sits behind a Supabase session JWT plus an email allowlist (`require_admin`), which no
CLI can mint. Actions happen in the admin web UI, pressed by a human.

## Running it

```bash
node --env-file=.env .claude/skills/member-triage/scripts/gather-member.mjs member@example.com
```

Run it from the repo root, where `.env` lives. It needs `STRIPE_API_KEY`,
`WIZARR_BASE_URL`, `WIZARR_API_KEY`, and SSH key auth to the NAS for the last two
sections. Each section degrades on its own: a dead upstream prints
`unavailable: <reason>` and the rest still print, so off the LAN you still get Stripe and
Wizarr.

`WZ_LOG_TAIL` (default 2000) widens the log window; `WZ_NAS_HOST` points at another NAS.

## Reading the dossier

- **Stripe** is the payment truth. `status=active` with a `paid` latest invoice means
  they are current. `status=canceled` with `ended` in the past means whatever disabled
  them was legitimate.
- **Wizarr** is the access truth, one record per server. There is no enabled flag to
  read: for Plex, Wizarr's disable falls back to deleting the record (Plex cannot disable
  a share, only unshare, which is why `disable_user` severs the friendship account wide).
  So no records means no access, and a record with a past `expires` means a lapsed
  window.
- **Bridge store** is the bridge's memory. `tier` drives the displayed tier, the
  downloads default, and the scope of the *next* invite. `subscribed` is the
  confirmed-payment flag written by the webhooks, and status keys off it, not off the
  expiry. `invited_at` starts the grace clock. `invite_code` is the last invite issued.
  Events are the audit trail.
- **Bridge logs** are the why. Member lines carry the email; the alarm pass catches the
  ones that do not (tier scope, unresolved tiers, tracebacks).

Status vocabulary (`memberStatus.ts`): **VIP** beats everything; **Subscribed Monthly**
and **Expired Member** are gated on `subscribed`, never on the presence of an expiry;
**Invited** and **Declined Invite** are `invited_at` inside or past the 14 day grace;
**Uninvited** is known to the bridge with no payment and no invite.

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

SMTP itself: `mailer.py` reads `SMTP_HOST/PORT/USER/PASS` at import and does STARTTLS
plus login on every send. Missing vars would stop the container booting at all, so a
running bridge with failing mail means bad credentials, a blocked port, or the provider
rejecting the from address. Fix `.env` on the NAS and rebuild (deploy-nas skill).

The link window is `INVITE_EXPIRES_DAYS`: the code default is 14 and `.env.example` ships
7, so read the live value instead of assuming.

## Case 3: disabled but believes they paid

Expect Wizarr `records: none found`. There is no "disabled" record to look at.

- **Canceled.** Store event "Canceled", log `disabled N record(s) for <email>`,
  `subscribed=0`, Stripe `status=canceled`. The system did the right thing. If they deny
  cancelling, check the latest invoice: a subscription ended by an unpaid invoice looks
  identical from Wizarr's side.
- **Re-scoped and never re-joined.** Log `reset N existing record(s) for <email> pending
  re-join`, an invitation still `pending`, `subscribed=1`. A tier change that dropped one
  of their servers forces disable-first, because Wizarr has no per-server unshare. They
  are mid-migration, not disabled. Resend the pending link.
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
  displayed tier, the downloads default, and the scope of their *next* invite. It does
  not touch their current Plex share.
- Actual access: `/user`, **Invite** with the right tier (`POST /admin/reissue-invite`),
  and the member must open the link. Redemption is where the share is re-scoped in place.
- Durable fix: add `metadata.tier` to the Payment Link in the Stripe dashboard, or the
  next buyer lands on bronze too.

**(b) The library set is wrong for the tier.** This is the tier-scope alarm pattern and
it is never a per-member problem. The dossier's alarm pass shows `tier scope check:
<tier> -> ...` or `youth allowlist mismatch on Meleys; missing [...]`. `tiers.py` matches
Plex library **names**: youth is a three-name allowlist, bronze is everything without
"4k" in the name, silver and gold take everything, and every tier is filtered to
`SHARE_SERVER` (Meleys) with `9X.` libraries stripped last and independently.

Point at the tier definitions, not the member. Rename back on Plex or update `tiers.py`,
then `bun run refresh:libraries`, `bun run test:bridge`, deploy, and only then reissue
the affected members. An invite already carries the library ids it was created with and
will not improve on its own.

**Downloads** are an override, not an access change: `/user`'s toggle
(`POST /admin/set-downloads`) changes the displayed value now and only takes effect on
Plex at the next reissued invite, because Wizarr has no per-user downloads endpoint.

## Case 5: renewal did not extend the expiry

Expected behaviour: `invoice.paid` with `billing_reason=subscription_cycle` sets every
record's expiry to now plus `ACCESS_DURATION` (35 days), absolutely, not additively, and
logs `renewed N record(s) for <email>`.

- `renewal: no wizarr user for <customer> / <email>`: there was nothing to extend. Their
  Plex account email differs from the Stripe email, or their records are gone.
- VIP: the log says VIP and the event reads "Payment received". Expiry is deliberately
  untouched. Not a bug, do not correct it.
- `skipping first (signup) invoice`: by design. The checkout already stamped the window.
- **No expiry at all** on a subscribed member: the hourly reconcile sweep stamps
  `invited_at` plus 35 days and logs `reconcile: stamped expiry ...`. Wait one
  `RECONCILE_INTERVAL_SECONDS` (3600) before touching anything. A missing expiry heals
  itself; a wrong one never does.

**Remedy.** `/user`, **Set expiry** to the paid date plus 35 days
(`POST /admin/reset-expiry` with an absolute `expires_at`). Then fix the cause: correct
the customer's email in the Stripe dashboard so the next `invoice.paid` resolves, or
reissue an invite so the store row and the Plex account line up. Setting the expiry alone
buys 35 days and nothing else.

## Case 6: member wants to cancel

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
Immediate revocation is a different act with a different button, and it is not what
cancel means here.

## Where each remedy happens

| Remedy | Where | Endpoint behind it |
|---|---|---|
| Issue or reissue a tier-scoped invite | `/user` **Invite / Re-invite**, or `/reset-user` tier buttons | `POST /admin/reissue-invite` |
| Set or clear an expiry | `/user` **Set expiry** / **Never expire** | `POST /admin/reset-expiry` |
| Correct the recorded tier only | `/user` **Hard reset tier** | `POST /admin/reset-tier` |
| VIP / HVU label | `/user` **Tag** | `POST /admin/set-tag` |
| Downloads override | `/user` downloads toggle | `POST /admin/set-downloads` |
| Schedule a cancel at period end | `/user` **Cancel subscription** | `POST /admin/cancel-subscription` |
| Confirm webhook delivery, fix a customer email, add `metadata.tier`, refund | Stripe dashboard | none |
| Delete a stale invitation, inspect a record | Wizarr API with `X-API-Key`, or the Wizarr UI | `/api/invitations`, `/api/users` |
| Fix a tier's library set | `tiers.py` plus the Plex library names, then deploy | none |

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
- "Never expire" is not a fix for a billing problem. Status is driven by `subscribed`, so
  clearing an expiry hides an unpaid member instead of resolving them.
- Two Stripe customers on one address is a real state, not a glitch. Read the whole
  Stripe section before concluding they never paid.
