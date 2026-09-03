# Billing failures: what the bridge does between a declined card and a cancellation

Stripe does not go straight from "payment failed" to "subscription deleted". It
spends weeks in between, retrying the charge while the member keeps the period
they already paid for. The bridge used to be deaf for that entire window, and
this document is the record of what that cost and what now covers it.

## The incident this came from (2026-09-02)

One member, two Stripe customers, one lost library:

|                | `jimmyvo768@gmail.com`                   | `jimmyvo767@gmail.com`                   |
| -------------- | ---------------------------------------- | ---------------------------------------- |
| customer       | `cus_Uy7XxcqWmbGh0a`, created 2026-07-28 | `cus_VAtOy3AxCWw4vI`, created 2026-08-31 |
| subscription   | `past_due`, delinquent                   | `active`                                 |
| latest invoice | `open`, unpaid, 2026-08-28               | paid 8.00 CAD, 2026-08-31                |

What actually happened, in order:

1. The July renewal charge declined. Stripe moved the subscription to
   `past_due` and started retrying.
2. **Stripe never told the bridge.** The webhook endpoint had exactly three
   events enabled: `checkout.session.completed`, `invoice.paid`,
   `customer.subscription.deleted`. `invoice.payment_failed` was not among
   them, so nothing was recorded and nothing was surfaced.
3. Because `subscribed` is only cleared by `customer.subscription.deleted`, the
   member kept reading **🟢 Subscribed Monthly** on `/manage` throughout.
4. Their access window ran out and Wizarr expired their records away. Their
   `/manage` row still showed "1 / 19" servers and libraries, because a member
   with no Wizarr record had those numbers derived from their tier rather than
   from anything they held. The row looked healthy while the person could not
   watch anything.
5. The member did not wait for the retry. They re-subscribed from scratch on
   2026-08-31, checking out under `jimmyvo767@gmail.com` while their Plex
   account remained `jimmyvo768@gmail.com`. Two addresses, one person. The
   bridge keys on email, so that payment arrived on a row with no records of
   its own, the renewal handler found nothing to extend, logged one WARNING
   line, and returned.
6. Net result: two live subscriptions billing one person, one of them still in
   dunning, and the person locked out with money taken.

The two addresses are not a mistake and were not "fixed" by deleting one: the
paid subscription was the one on the address that was _not_ the Plex account.
See **One person, two addresses** below for how the bridge now joins them.

Every step above is now covered by a test.

## Events the webhook endpoint must send

The bridge handles five. All five must be enabled on the Stripe endpoint or the
handler for them is dead code:

| Event                           | What the bridge does                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `checkout.session.completed`    | issue a tier-scoped invite, mail it, clear any dunning flag                                |
| `invoice.paid`                  | clear the dunning flag, extend expiry, **or recover access if there is nothing to extend** |
| `invoice.payment_failed`        | flag `past_due`; access untouched                                                          |
| `customer.subscription.updated` | mirror `past_due` / `unpaid` / `active` onto the flag                                      |
| `customer.subscription.deleted` | clear `subscribed`, disable records                                                        |

Check what is actually enabled before assuming, because a missing event fails
silently in exactly the way described above:

```bash
curl -s https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_API_KEY:" \
  | python3 -c "import json,sys; [print(e['url'], sorted(e['enabled_events'])) for e in json.load(sys.stdin)['data']]"
```

**Order matters when adding the two new events.** An event type the running
bridge has no branch for falls through `_dispatch` and is then written to
`processed_events`, so it is swallowed and never reprocessed. Deploy the bridge
first, confirm `GET /stripe/version`, and only then enable
`invoice.payment_failed` and `customer.subscription.updated` in Stripe.

## `payment_state`: the flag between paid and cancelled

`customer_map.payment_state` is `NULL` (nothing known to be wrong) or
`"past_due"` (Stripe has a failed charge outstanding). It is deliberately
separate from `subscribed`:

- `subscribed` answers "have they ever paid, and is the subscription alive".
- `payment_state` answers "is a charge failing right now".

A member in dunning has still paid for the period they are in, so **the bridge
never revokes access on a failed payment**. What changes is that the admin UI
stops calling them healthy: `deriveStatus` returns **🟠 Payment Failed**, which
ranks above Subscribed Monthly and below both VIP and Expired Member, and
`/manage` grows a "Payment failed" filter pill so the whole dunning set is one
click away.

The flag clears on any paid invoice for that email, including the signup
invoice that the renewal path otherwise skips, and on a completed checkout.

## Recovery: a payment that finds no records

`invoice.paid` with no resolvable Wizarr records used to be a no-op with a
warning. It now calls `restore_access`, which issues a fresh tier-scoped
invite, mails it, writes an **Access restored** event to the member's history,
and sends an operator alert. VIPs are exempt (their access is never
time-boxed, so the renewal path returns before recovery is reached).

This is the same remedy an admin would press by hand on `/user`. The bridge
does it itself because the failure is invisible from the member's side: they
have paid, and the only signal that anything is wrong is that nothing works.

Recovery cannot fire more than once per invoice, so the worst case is one extra
invite per billing cycle for a member who never redeems.

## One person, two addresses

A member can check out with one email and create their Plex account with
another. That is not a mistake to correct, it is the normal shape of a
household where the card and the Plex login are not the same address. The
bridge keys its store on the checkout email and Wizarr keys its records on the
Plex email, so nothing joins them by string comparison.

**The invite is the join.** The bridge issues an invite against the checkout
email; whoever redeems it is the person who paid for it. So
`invitations[].used_by` resolves to a Wizarr record, that record has the Plex
email, and the customer row that issued the code belongs to that person.
`_plex_email_by_invite` and `_customer_by_plex_email` in `admin.py` do exactly
that, and `/admin/members` then emits **one** row instead of two:

- `email` is the Plex address, the one they actually watch with.
- `stripe_email` is the checkout address, **set only when it differs**. Equal
  addresses leave it `null` so the UI has nothing extra to render.
- the customer row's tier, `subscribed`, `payment_state` and `customer_id` all
  follow the person, not the string.

The customer that got claimed this way is dropped from the pending list, which
is what collapses "two entries for one person" into one. The member page shows
a **Stripe email** row, and `/manage` shows `pays as <address>` under the
member's email, in both cases only on a real mismatch.

Note the linkage needs an invite the **bridge** issued, because the code has to
be in `customer_map.invite_code`. An invite created directly against the Wizarr
API links nothing, however correctly scoped it is.

## Two unlinked customers for one person

The bridge keys everything on email, so two addresses are two members and a
payment on one can never rescue the other. Nothing merges them automatically:
merging billing identities is a refund-shaped decision, not a webhook's call.

What the admin UI does instead is flag the pair. `findDuplicateEmails` marks
any two members with a payment signal whose addresses are either the same
mailbox written differently (Gmail ignores dots and `+tags`) or a single edit
apart, and `/manage` renders a **possible duplicate** badge on both rows. The
operator reconciles it in Stripe.

The badge and the `stripe_email` join answer different questions. The join says
"these two addresses are provably one person, because one redeemed the other's
invite". The badge says "these two look like one person, but nothing proves
it". A pair stays badged until a bridge-issued invite is redeemed.

## What the members list is allowed to claim

`servers` and `libraries` on a member payload are what the person can actually
watch: their Wizarr records, unioned with their live plex.tv share. `entitled`
is the separate, tier-derived answer to "what would redeeming grant them".

They must not be conflated. Filling `servers` from the tier is what let a
locked-out member read "1 server, 19 libraries", and the member page already
had `entitled` for the legitimate need (rendering a real Servers section for
someone mid-invite).
