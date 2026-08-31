# Invite flow: what happens when an invite is sent to an email

The headline: **existing access survives the invite window.** Nothing is removed when the invite goes out — the swap happens at redemption, when Wizarr re-scopes the member's share in place to the new tier. The one exception is a tier change that drops a server the member currently has (Wizarr has no per-server unshare), which falls back to the old disable-first flow.

## Phase 1 — In the browser (`/user` or `/manage`)

Click **Invite / Re-invite**, pick a tier from the menu, and confirm in the modal. The page then POSTs to the bridge: `POST /admin/reissue-invite` with `{ email, tier }` and the admin password header. Nothing has changed anywhere yet — this is pure UI.

## Phase 2 — Inside the bridge (`reissue_invite` in `admin.py`), one synchronous request

1. **Normalize the tier.** Unknown/malformed tier strings fall back to bronze (`tiers.normalize_tier`).
2. **Resolve what the tier may see.** The bridge pulls the live library list from Wizarr and applies the tier rules: youth = a three-library allowlist, bronze = everything that isn't 4K, silver/gold = everything. A private filter runs _last_ and independently — any library named `9X. …` is stripped no matter what the tier rules said. Zero resolved libraries aborts with a 502 before anyone is touched.
3. **Look up the member's existing Wizarr records** by email — one record per server. Still nothing has changed.
4. **Create the new invite.** `POST /api/invitations` to Wizarr with the resolved server ids, the scoped library ids, `allow_downloads` from the tier, a 14-day link expiry (`INVITE_EXPIRES_DAYS`), and a 35-day access duration (`ACCESS_DURATION`).
5. **Write the pending row** to the bridge's SQLite: email → new invite code + tier + `invited_at` (the grace-period clock). This keeps the member on `/admin/members` and drives the Invited / Declined Invite status.
6. **Coverage check — the only removal path left.** If every server the member currently sits on is covered by the new tier's scope, nothing is disabled and their access continues untouched. If the new tier leaves a current server uncovered (e.g. Gold → Youth), there is no per-server unshare in Wizarr — disable severs the whole plex.tv friendship — so the reissue falls back to disabling **every** record (fail closed on stale access), and the member has a gap until they redeem.
7. **Email the link** ("Your Westeroz access link", expires in 14 days). An SMTP failure does not roll anything back — the response returns `emailed: false` so the admin can send the URL manually.
8. **Record the history event** ("Invite issued") and return `{ url, code, tier, disabled: N, emailed }`.

Back in the browser, the member's tier and downloads update and the grace clock restarts. A member with active access stays 🟢 Subscribed Monthly; a member without access shows 🟡 Invited.

## Phase 3 — The wait, and the grace period

- The member keeps whatever access they already had (covered-server case).
- A member with no access (or a legacy share holding an outstanding invite) reads **🟡 Invited** for 14 days from `invited_at`.
- If the invite sits unredeemed past 14 days, the status ages into **🚫 Declined Invite**. The link itself also expires at 14 days (`INVITE_EXPIRES_DAYS` matches the grace period), so a lapsed member needs a fresh reissue.

## Phase 4 — Redemption: where the swap actually happens

The member opens `{PUBLIC_INVITE_BASE}/j/{code}` and signs in with their **Plex account**. Wizarr redeems the invite:

- **Already a friend** (the normal re-invite case): Plex raises "already sharing", Wizarr catches it and calls `update_user_libraries` + `update_user_permissions` — the share on each covered server is **replaced in place** with exactly the new tier's libraries and downloads setting. This is the removal-and-grant, atomically per server. Wizarr also deletes and recreates its user records, so expiry becomes now + 35 days.
- **Not a friend** (first join, or after a disable-first fallback): Wizarr shares the scoped libraries fresh, re-establishing the friendship.

The bridge plays no part in redemption — it finds out when `/api/users` next shows the records, and the admin UI flips to 🟢 Subscribed Monthly with the real expiry.

## Sharp edges

- The 35-day clock starts at **redemption**, not at invite creation or payment.
- A tier change that drops a server (Gold → Youth) still uses disable-first with an access gap — that's the fail-closed fallback, not a bug.
- If the member's Plex email differs from their Stripe email, the checkout path can't evaluate server coverage and also falls back to disable-first.
- The hourly reconcile sweep stamps the paid expiry on records that joined without one, matching by email first; when the Plex email differs from the Stripe email it finds the records through the invite's `used_by` instead. The invite email tells new members to create their Plex account with the address it was sent to, so the mismatch should stay rare.
- Deployed-Wizarr API surface (why all this shape exists): user mutations are only delete / disable / enable / extend / reset-password / update-expiry — no per-user library endpoint, no per-server unshare.
