# Decouple "Invited" from "Subscribed Monthly" + backfill the 44 non-VIP members

**Date:** 2026-07-24
**Status:** Approved design

## Problem

The admin panel must be able to show a member as **"Invited"** while that member
also carries a **14-day Wizarr access expiry**: so that manually-invited legacy
members get a real 14-day countdown to sign up, yet are not mislabeled as paying
subscribers.

Today this is impossible. The bridge derives `subscribed` as `expires != null`,
and `deriveStatus` checks `subscribed` **before** the "Invited" branch. Any
member with a future expiry therefore reads **"Subscribed Monthly"**. The two
requirements ("Invited" + a real expiry) are mutually exclusive under the current
logic.

The fix replaces the inferred `subscribed` signal (derived from the expiry) with
a **real payment signal** maintained by the Stripe webhooks. "Subscribed Monthly"
then means "an actual payment was confirmed", independent of any expiry, so a
member can be "Invited" and have an expiry at the same time.

### Low-risk context

Every Wizarr user currently has `expires: null`, so **no member shows
"Subscribed Monthly" today**. Redefining what `subscribed` means carries
essentially zero regression risk.

## Goals

- A member with **no confirmed payment** + a **future Wizarr expiry** + a
  **fresh `invited_at` stamp** reads **"Invited"** (with a ✉️ emoji), and the
  Expires column shows the date.
- **"Subscribed Monthly"** is driven only by a confirmed Stripe payment, and
  flips on the moment the payment webhook fires.
- The 44 non-VIP members are stamped "Invited" and given a real 14-day expiry
  (access is actually removed by Wizarr at +14d if they don't sign up).
- **VIP members are never touched**: no stamp, no expiry, status stays "VIP".
- **HVU becomes a pure administrative label**, not a status.

## Non-goals

- No change to Plex library scoping, tiers, downloads, renewals, or the
  invite-redemption flow.
- No change to how access loss is enforced; that stays entirely Wizarr's job,
  via the expiry date, exactly as today.
- No new admin UI controls (the backfill is a one-time script, not a button).

## Design

### Part 1: Bridge: a durable `subscribed` flag

**Schema (`stripe-bridge/store.py`)**

- Add `subscribed INTEGER NOT NULL DEFAULT 0` to the `customer_map` table.
- Add a migration `_ensure_subscribed_column(c)` mirroring the existing
  `_ensure_invited_at_column` (idempotent `ALTER TABLE ... ADD COLUMN`, no-op
  once present). Call it from `init_db`.

**Store helpers (`store.py`)**

- `upsert_pending(...)` (the real-payment path) sets `subscribed = 1` on the row
  it writes.
- New `set_subscribed(path, email, value: bool) -> None`: updates every row for
  the email (case-insensitive), used by the renewal and cancel handlers.
- `all_customer_rows(...)` returns `subscribed` alongside `tier` and
  `invited_at`: `{email: {"tier", "invited_at", "subscribed"}}`.

**Webhook transitions (`stripe-bridge/stripe_wizarr_bridge.py`, `_dispatch`)**

- `checkout.session.completed` → already calls `upsert_pending`, which now sets
  `subscribed = 1`.
- `invoice.paid` (renewal; the signup invoice is already skipped) →
  `store.set_subscribed(MAP_DB_PATH, email, True)`.
- `customer.subscription.deleted` → `store.set_subscribed(MAP_DB_PATH, email, False)`.

**Member payload (`stripe-bridge/admin.py`)**

- `_dedupe_members`: `"subscribed": bool(row.get("subscribed"))` (from the joined
  customer row) instead of `person["expires"] is not None`.
- `_member_from_customer`: `"subscribed": bool(row.get("subscribed"))`.

The `Member.subscribed` field in `web/src/lib/adminApi.ts` is already a boolean;
no payload-shape change is needed.

### Part 2: Frontend: reorder `deriveStatus`

`web/src/lib/memberStatus.ts`. `subscribed` now means "confirmed active payment".

New precedence:

| Condition                                            | Status                                            |
| ---------------------------------------------------- | ------------------------------------------------- |
| tag `vip`                                            | **VIP** (overrides everything, access protected) |
| `subscribed` **and** expiry in the past              | Expired Member                                    |
| `subscribed`                                         | Subscribed Monthly                                |
| not subscribed, `invited_at` within the 14-day grace | **Invited**                                       |
| not subscribed, `invited_at` older than the grace    | Declined Invite                                   |
| not subscribed, no invite stamp                      | Uninvited                                         |

Changes from today:

- **HVU removed.** Delete the `if (member.tag === 'hvu') return 'HVU'`
  short-circuit. Remove `'HVU'` from the `MemberStatus` union. HVU-tagged members
  now show their real lifecycle status; `hvu` remains a `member.tag` value shown
  as the administrative tag in the member **detail view** only. Consequence: the
  HVU tag no longer appears in the members-table Status column.
- **"Expired Member" is now subscribed-only.** An unpaid invite whose expiry
  lapses becomes **"Declined Invite"** (via the not-subscribed + past-grace
  branch), not "Expired Member". Because the invite grace (14 days) equals the
  manual expiry window (14 days), the status ages to "Declined Invite" exactly as
  Wizarr removes access.
- The `!member.servers.length` special case that previously returned "Invited"
  for a stampless member is dropped; a not-subscribed member with no invite stamp
  is "Uninvited".

### Part 3: UI: ✉️ on "Invited"

- Add `Invited: '✉️'` to the status-emoji map(s) and render it next to the word,
  the same decorative pattern as `💎` for VIP (`aria-hidden="true"`, so screen
  readers still announce the text "Invited").
- `web/src/components/MembersTable/MembersTable.tsx`: render ✉️ in the Status
  cell for `status === 'Invited'`.
- `web/src/pages/User/User.tsx`: add `Invited: '✉️'` to `STATUS_EMOJI`; drop the
  `HVU` status handling (the `hvu` **tag** display is unchanged).

### Part 4: One-time backfill of the 44 (runs after deploy)

An **idempotent** script (`stripe-bridge/scripts/backfill_invited_expiry.py`) run
inside the bridge container: it has the DB path, the Wizarr client, and env.

For each of the 44 emails (listed below), in order:

1. **Guard: skip if:** the member's tag is `vip`, **or** the member is already
   `subscribed`. (HVU is _not_ skipped, treated as a normal member.)
2. Stamp the bridge: `invited_at = now`, `subscribed = 0`, `tier = null`
   (Unknown), no invite code: inserting an `admin:<email>` row if none exists,
   or refreshing `invited_at` on the existing row. Result: status → **Invited**.
3. Set the Wizarr expiry to **now + 14 days** on every server record for the
   email (the same `WizarrClient.set_expiry` call `reset-expiry` uses). Result:
   Expires column shows the date; Wizarr enforces access removal at +14d.
4. Record a member event: `"Invited, manual, access ends <YYYY-MM-DD>"`.

**Ordering:** the new bridge code (Part 1) **must be deployed first**. If the
expiry were set while the old `subscribed = expires != null` logic is live, the
44 would flash as "Subscribed Monthly" until deploy.

**`invited_at` is a bridge concept**, not a Wizarr field. "Invited date = now"
lives in `customer_map`; the Wizarr-side representation of the 14-day window is
the expiry date. There is no separate Wizarr "invited" timestamp to set.

**The 44 emails** (roster minus the 5 VIP emails; auditable, strike any before
running):

```
amolsharma@me.com              andrewmasonmac@gmail.com       andrew.a.donald@gmail.com
oe.andy0102@gmail.com          artirawal2009@gmail.com        ayosalawu@gmail.com
codebenderinc@gmail.com        chrismanocchio@gmail.com       christopherlukestewart@gmail.com
cuallijulius@gmail.com         danny.p.79@icloud.com          davejmcg@gmail.com
harpreetmand@gmail.com         harmancheema07@gmail.com       higorsalesart@gmail.com
jamal.tobias@gmail.com         jean.abousaab@gmail.com        jeffreceno@hotmail.com
jimmyvo768@gmail.com           jroberts0985@gmail.com         karensjahn@gmail.com
kensuong@gmail.com             kkalawi@gmail.com              lauramjbowers@gmail.com
809lenny@gmail.com             luxman.thevathasan@gmail.com   m.mcphaden@live.ca
macklewis16@gmail.com          mattbk.cb@gmail.com            stefuraknataliia@gmail.com
nicklhw@gmail.com              pollux527@hotmail.com          contactprerit@gmail.com
ramiandari@gmail.com           rita.duchak@icloud.com         rodrigobocaiuva@gmail.com
rorosha13@gmail.com            ryan.duchak@gmail.com          schopra86@live.com
canexan@gmail.com              jbloco26@gmail.com             gmacgregor@gmail.com
Toronto0442@gmail.com          william@wcarroll.com
```

The 5 excluded VIPs: `cindy.rivas@gmail.com`, `freenow82@gmail.com`,
`jjanet.alfaro@gmail.com`, `max.rivas.alfaro@gmail.com`, `nammerella@gmail.com`.

## Edge cases

- **A backfilled member later pays.** `checkout.session.completed` runs
  `upsert_pending`, which deletes the `admin:<email>` placeholder, writes a real
  Stripe-id row with `subscribed = 1` → status flips to "Subscribed Monthly". The
  manual expiry is superseded by the normal renewal flow.
- **14 days pass with no payment.** `invited_at` ages past the grace →
  "Declined Invite"; Wizarr removes access as the expiry passes. Consistent.
- **A member later cancels.** `customer.subscription.deleted` clears the flag
  (`subscribed = 0`) and disables the Wizarr records; no longer "Subscribed
  Monthly". (Correctly handled by the durable flag; the old id-prefix approach
  could not do this.)
- **VIP with a customer_map row** (e.g. a VIP who also has a Stripe record):
  `tag === 'vip'` short-circuits `deriveStatus`, so status stays "VIP"
  regardless of the flag, and the backfill guard never touches them.
- **`codebenderinc@gmail.com`** already has a stale `invited_at`; the backfill
  refreshes it to now and sets the expiry (it is not `subscribed`). If this is a
  personal test account, strike it from the list before running.

## Testing (TDD)

**Bridge (`stripe-bridge/tests/`)**

- `test_store`: new `subscribed` column defaults to 0; `set_subscribed` toggles
  every row for an email; `all_customer_rows` carries `subscribed`;
  `upsert_pending` sets `subscribed = 1` and clears the admin placeholder.
- webhook tests: `checkout.session.completed` → flag set; `invoice.paid`
  (non-signup) → flag set; `customer.subscription.deleted` → flag cleared.
- `test_admin`: members payload `subscribed` reflects the flag, not the expiry
  (a member with a future expiry but flag 0 is `subscribed: false`).

**Frontend**

- `memberStatus.test.ts`: subscribed=false + future expiry + fresh `invited_at`
  → "Invited"; subscribed=false + stale `invited_at` → "Declined Invite";
  subscribed=true → "Subscribed Monthly"; subscribed=true + past expiry →
  "Expired Member"; `hvu` tag no longer forces "HVU" (shows lifecycle status);
  `vip` tag still overrides.
- `MembersTable.test.tsx` / `User.test.tsx`: ✉️ renders for "Invited"; the HVU
  tag no longer surfaces as a table status.

## Protected / untouched

VIP access (no expiry, no stamp, status stays VIP), Plex library scoping, tiers,
downloads, subscription renewals, and the invite-redemption flow.
