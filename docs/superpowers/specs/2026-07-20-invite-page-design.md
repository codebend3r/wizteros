# /invite page — invite a brand-new person

**Date:** 2026-07-20
**Status:** Approved (design), pending implementation plan

## Goal

An admin-only `/invite` page that invites a brand-new person to the server: type
an email address, pick a tier (Bronze / Silver / Gold / Youth), send the invite.
This is the "first join" counterpart to the `/user` **Re-invite** flow, which
only operates on people who already exist as members.

## Approach

**Frontend-only.** No bridge changes. The existing
`POST /admin/reissue-invite` endpoint already handles a brand-new email
correctly:

- `find_users_by_email` returns `[]`, so `stale_record_ids` returns `[]` and
  nothing is disabled.
- The scoped invite is created for the tier.
- `store.upsert_pending_by_email` writes the pending row (tier + `invited_at`),
  which is what makes the new person appear on `/manage` as **🟡 Invited** and
  drives the grace clock.
- The invite email is sent; the response reports `emailed` and the link `url`.

So "invite new" and "re-invite" hit the same endpoint; the only real difference
is the UI and a client-side guard against typing an email that already belongs
to a member.

The bridge's `reissueInvite` API wrapper and `InviteResult` type in
`web/src/lib/adminApi.ts` are reused as-is.

## Routing & entry points

- New route `/invite` in `web/src/AppRoutes.tsx`, wrapped in `AdminGate` (same
  pattern as `/manage`, `/user`, `/reset-user`).
- New **"Invite someone"** button/link on `/manage`, near the members table
  (above the search box), pointing to `/invite`.
- `/invite` has an **← All members** back link to `/manage`, mirroring the
  `/user` page's back link.

## Page structure (`web/src/pages/Invite/Invite.tsx`)

Follows the `/user` page shape: an `Invite` wrapper around `AdminGate`, an
`InviteInner` that uses `useAdminAuth`, wrapped in `AdminLayout`.

Form:

1. **Email input** — a controlled `type="email"` field. Trimmed on use. The
   Send button is disabled until the value is a plausible email
   (non-empty, contains `@` with something either side — a light client check,
   not RFC validation; the bridge/Wizarr is the real authority).
2. **Tier picker — four cards.** One selectable card per `PAID_TIERS` entry
   (`bronze`, `silver`, `gold`, `kids`), each showing its `<TierIcon />`, the
   `TIER_LABELS` name, and a one-line summary. **Nothing is preselected** — the
   Send button stays disabled until a tier is chosen, so an accidental Enter
   can't fire a default tier.
   - Card summaries (static copy on the page, describing the tier rules that
     live in `stripe-bridge/tiers.py`):
     - Bronze — "Everything except 4K · no downloads"
     - Silver — "Everything · no downloads"
     - Gold — "Everything · downloads included"
     - Youth — "Kid-safe libraries only · downloads included"
3. **Send invite** button — opens the confirm modal (does not send directly).

### Duplicate-email guard (block + link to /user)

Requirement: if the typed email already belongs to an existing member, **block**
the send and point the admin at `/user?email=…` to use the Re-invite flow there.

- The page loads the shared members query (`MEMBERS_QUERY_KEY = ['members']`,
  `fetchMembers`) — the same authoritative list `/manage` renders. When the
  admin has already visited `/manage`, this is served instantly from the
  persisted query cache. Since the entry point is the **Invite someone** link on
  `/manage`, the cache is warm on the normal path and the guard is instant.
- **Guard readiness.** The form (email + tier) is always usable, but the primary
  **Send invite** button is gated on the members query being resolved: while it
  is still loading (cold cache — direct navigation to `/invite` without visiting
  `/manage`), Send is disabled with a "Checking members…" hint. This guarantees
  the duplicate check can actually run before any send, honoring the block
  intent. On the warm path this state is never seen.
- On send attempt, the trimmed email is compared case-insensitively against
  `members[].email`. A match blocks: instead of the confirm modal, the page
  shows an inline notice — e.g. **"cody@example.com is already a member (Gold).
  Use Re-invite instead."** — with a link to `/user?email=<encoded>`. The tier
  named in the notice comes from the matched member row.
- This mirrors the exact list `/manage` shows, so it is authoritative for
  everyone the members endpoint knows (redeemed Wizarr users **and** pending
  Stripe subscribers who haven't joined — the bridge unions both in
  `list_members`).
- **Known limit (documented, not fixed here):** the guard is only as fresh as
  the members query. Someone created seconds ago on another device, with the
  cache not yet refetched, could slip through. This is acceptable because the
  underlying send is still safe — the bridge treats a duplicate as a re-invite
  (existing access survives until redemption; nothing is destroyed). The guard
  is a convenience against the common mistake, not a hard invariant. The `/user`
  Re-invite path remains the tool for intentional re-invites.

### Confirm modal (new invitee)

`ConfirmInviteModal` as it stands takes a full `Member` object and its body text
says existing server records "are disabled" — both are wrong for a brand-new
person. Rather than overload it, `/invite` uses `ConfirmActionModal` directly
(the same primitive `ConfirmInviteModal` and the `/user` reset modals build on)
with new-invite-appropriate content:

- Title "Confirm invite", confirm label "Send invite", busy label "Sending…".
- A `<dl>` showing **Email**, **Tier** (icon + label), **Downloads**
  (Included / Not included from `TIER_DOWNLOADS`), **Access**
  (`{ACCESS_DAYS} days per billing cycle`), **Link valid for**
  (`{INVITE_LINK_DAYS} days`).
- A note written for a first join: a fresh {tier}-scoped invite link is
  generated and emailed; they join through the link with their Plex account. No
  mention of disabling existing records.

(If we later want to share markup, `ConfirmInviteModal` could grow a
new-invitee mode, but that refactor is out of scope for this page.)

### After a successful send (result + link to /user)

- Stay on `/invite`.
- Show a result notice reusing the `/manage` / `/user` pattern:
  - emailed → "Invite emailed. Link: `<url>`"
  - not emailed → "Email failed — send this link manually: `<url>`"
- Add a **View member** link to `/user?email=<encoded>` (the new person now
  exists as a pending 🟡 Invited member there).
- **Clear the form** (email + tier selection reset) so the admin can invite the
  next person without stale state.
- **Prime the members cache** so the new invitee shows up immediately if the
  admin navigates to `/manage` or `/user`: on success, insert/update the row in
  `MEMBERS_QUERY_KEY` (append a pending-shaped member with the chosen tier,
  `downloads` from `TIER_DOWNLOADS`, `invited_at = now`, empty servers/libraries,
  `subscribed: false`, `expires: null`) — the same optimistic shape `/manage`
  and `/user` already write after an invite, matching `_member_from_customer`
  on the bridge. If the email somehow already existed in the cache, update in
  place instead of appending.

### Errors

- `AdminAuthError` → `deauthenticate()` (same as the other admin pages).
- Any other send failure → inline "Could not create invite." error, form
  state preserved so the admin can retry.

## State (mirrors `/user`)

- `email: string` (controlled input)
- `tier: PaidTier | null` (selected card; null = none)
- `inviteResult: InviteResult | null`
- `blockedMember: Member | null` (set when the guard matches; drives the
  "already a member" notice + `/user` link)
- `actionError: string | null`
- confirm-open flag (e.g. `confirming: boolean`, or reuse a pending-tier
  pattern) — send happens only from the modal's onConfirm
- `useMutation` over `reissueInvite({ email, tier, password })`, `useQuery` over
  `fetchMembers` for the guard.

## Styling

- New `Invite.module.scss` SCSS module. Tier cards laid out with CSS grid + gap;
  design tokens from `styles/globals.scss` for colors/spacing/radius/fonts
  (per repo CSS conventions — container-driven, no bare divs, no margins for
  spacing).
- Reuse existing primitives: `AdminLayout`, `AdminGate`, `TierIcon`,
  `ConfirmActionModal`, `Preloader`.

## Testing (Vitest + Testing Library, matching existing page tests)

`web/src/pages/Invite/Invite.test.tsx`:

- Renders behind `AdminGate` (password required).
- Send disabled until both a valid-looking email and a tier are chosen.
- Selecting a tier card + valid email enables Send; opens confirm modal;
  confirming calls `reissueInvite` with the right `{ email, tier }`.
- Duplicate email (present in mocked members query) → blocked, no mutation,
  shows the "already a member" notice with a `/user?email=…` link.
- Successful send → shows result notice with the invite URL, a **View member**
  link, and clears the form.
- Email-failed result → shows the manual-link copy.
- `AdminAuthError` from the mutation → triggers deauthenticate.

Also update `web/src/pages/Manage/Manage.test.tsx` (or add coverage) for the new
**Invite someone** link to `/invite`, and add the route assertion if
`AppRoutes` is covered.

## Files

- **New:** `web/src/pages/Invite/Invite.tsx`, `Invite.module.scss`,
  `Invite.test.tsx`
- **Edit:** `web/src/AppRoutes.tsx` (add route),
  `web/src/pages/Manage/Manage.tsx` (add "Invite someone" link),
  `web/src/pages/Manage/Manage.module.scss` (link styling if needed)
- **Reused unchanged:** `adminApi.reissueInvite` / `InviteResult`,
  `inviteRules` (`PAID_TIERS`, `TIER_LABELS`, `TIER_DOWNLOADS`, `ACCESS_DAYS`,
  `INVITE_LINK_DAYS`), `AdminGate`, `AdminLayout`, `TierIcon`,
  `ConfirmActionModal`, `Preloader`
- **No bridge changes.**

## Out of scope

- No new bridge endpoint; no server-side duplicate rejection (the client guard +
  the bridge's safe re-invite semantics cover it).
- No batch/CSV invite.
- No refactor of `ConfirmInviteModal` into a shared new/re-invite component.
