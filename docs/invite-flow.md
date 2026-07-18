# Invite flow: what happens when an invite is sent to an email

The headline: **removal happens in the middle of the reissue request itself — seconds after the new invite is created — and the re-add doesn't happen until the member clicks the link and signs in with Plex.** Everything between those two moments is a gap where they have zero access anywhere.

## Phase 1 — In the browser (`/user` or `/manage`)

Click **Invite / Re-invite**, pick a tier from the menu, and confirm in the modal. The page then POSTs to the bridge: `POST /admin/reissue-invite` with `{ email, tier }` and the admin password header. Nothing has changed anywhere yet — this is pure UI.

## Phase 2 — Inside the bridge (`reissue_invite` in `admin.py`), one synchronous request

1. **Normalize the tier.** Unknown/malformed tier strings fall back to bronze (`tiers.normalize_tier`).
2. **Resolve what the tier may see.** The bridge pulls the live library list from Wizarr and applies the tier rules: kids = a three-library allowlist, bronze = everything that isn't 4K, silver/gold = everything. A private filter runs _last_ and independently — any library named `9X. …` is stripped no matter what the tier rules said, so a rule change can never leak a private library. If this resolves to zero libraries, the whole request aborts with a 502 — deliberately fail-closed, and importantly _before_ anyone is touched.
3. **Look up the member's existing Wizarr records** by email (`find_user_ids_by_email`) — one record per server, so a member on five servers yields five ids. Still nothing has changed.
4. **Create the new invite first.** `POST /api/invitations` to Wizarr with the resolved server ids, the scoped library ids, `allow_downloads` from the tier, a 7-day link expiry (`INVITE_EXPIRES_DAYS`), and a 35-day access duration (`ACCESS_DURATION`). The ordering is deliberate and documented in the code: if invite creation failed _after_ the disable step, the member would be locked out with no link to redeem.
5. **Write the pending row** to the bridge's SQLite (`upsert_pending_by_email`: email → new invite code + tier). Without this the member would vanish from `/admin/members` the moment their Wizarr records go away in the next step.
6. **⚠️ THE REMOVAL.** For each user id from step 3, `POST /api/users/{id}/disable`. This is where access dies — and note it's account-wide: disabling severs the plex.tv friendship, which kills their share on **every** server at once, not just the servers in this tier. For a member with no records left, this loop simply runs zero times.
7. **Email the link** (`send_invite_email` over SMTP/STARTTLS: "Your Westeroz access link", expires in 7 days). An SMTP failure does _not_ roll anything back — the reissue already happened — the response just comes back with `emailed: false` so the admin can send the URL manually.
8. **Record the history event** ("Invite issued — gold tier — link emailed") and return `{ url, code, tier, disabled: N, emailed }`.

Back in the browser, the caches now show the member as 🟡 **Invited** (tier and downloads updated, expiry and servers cleared).

## Phase 3 — The gap

The member is store-row-only: known to the bridge, invisible to Wizarr, no Plex access on any server. This lasts until they act. If the link sits unused past 7 days it expires and a new reissue is needed; the pending Wizarr invitations from dead reissues just accumulate as clutter.

## Phase 4 — ⚠️ THE RE-ADD (entirely member-driven, entirely inside Wizarr)

The member opens `{PUBLIC_INVITE_BASE}/j/{code}` and signs in with their **Plex account**. Wizarr redeems the invite: it calls Plex to share exactly the invite's scoped libraries with that account on each server (re-establishing the friendship), and creates fresh user records with expiry = now + 35 days. The bridge plays no part in this — it finds out after the fact, when `/api/users` next shows records for that email (with `find_user_ids_by_invite` as a fallback for people whose Plex email differs from their Stripe email). That's when the admin UI flips to 🟢 Subscribed Monthly with the real expiry.

## Sharp edges

- The 35-day clock starts at **redemption**, not at invite creation or payment.
- Because removal is friendship-level while re-adding is per-invite-scope, a reissue is the only mechanism that can _shrink_ someone's libraries — the deployed Wizarr API has no in-place re-scope (its full user-mutation surface is delete / disable / enable / extend / reset-password / update-expiry).
