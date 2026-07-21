# Copy-all-emails button + `/email` compose page

## Goal

Give the admin a fast way to email every Plex member:

1. A top-right button that copies all member emails as a comma-separated list (for pasting into a mail client).
2. A new `/email` route with the same copy button plus a compose form whose recipients are shown as removable chips, so the admin can exclude anyone before handing off to their mail client.

There is **no server-side email sender** in this app, so "Send" is a pure client-side hand-off via a `mailto:` link. This is consistent with the copy-to-clipboard intent.

## Components

### `CopyEmailsButton` (new, reusable) — `src/components/CopyEmailsButton/`

- Props: `emails: ReadonlyArray<string>`.
- Click writes a **deduped, empty-filtered, comma-separated** list to the clipboard via `navigator.clipboard.writeText`.
- Label flips to `Copied!` for ~2s, then reverts. On clipboard failure, shows `Copy failed`.
- Disabled when the deduped list is empty.
- Used on `/manage` and `/email` so copy behavior lives in one place.

### Members page (`/manage`) — edit

- Wrap the `Members` `<h1>` and the action links in a title row (CSS grid, title left / actions right) so the copy button sits **top-right**.
- Add an `Email all members` link (→ `/email`) alongside `+ Invite someone`.
- Copy button receives `members.map(m => m.email)`.

### `/email` page (new) — `src/pages/Email/`

- Same `AdminGate` + `AdminLayout` shell and `fetchMembers({ password })` query (shared `MEMBERS_QUERY_KEY`) as Manage/Invite.
- Title row: `← All members` back link + title, copy button **top-right**.
- **Recipient chips**: one chip per member email, each with an `×` remove control. Exclusions are local state (a `Set<string>` of excluded emails). A count reads `N recipients`. A `Reset` control (shown only when at least one is excluded) restores all.
- **Subject** input + **Message** textarea (both optional; the form is a hand-off, not validated content).
- **Send email** button builds `mailto:?bcc=<remaining>&subject=<subject>&body=<body>` (recipients in **BCC** to keep addresses private) and opens it via `window.location.href`. Disabled when zero recipients remain.

### Route — edit `src/AppRoutes.tsx`

- Add `<Route path="/email" element={<Email />} />`.

## Data flow

`fetchMembers` → `Member[]` → `emails = members.map(m => m.email)`. The copy button and the chip list both derive from this. Chip exclusions live only in the `/email` page's local state; nothing is persisted and no member data is mutated.

## Edge cases / trade-offs

- Emails are deduped (case-insensitive) and empties filtered in both the copy list and the BCC list.
- `mailto:` URLs have practical length limits (~2000 chars in some OS/mail clients); the current member count is well within this, but a very large list could be truncated by the client. Noted, not engineered around.
- Clipboard API requires a secure context (https/localhost); failure path surfaces `Copy failed`.
- No backend changes.

## Testing

- `CopyEmailsButton`: copies comma-joined deduped list, dedupes/filters empties, shows `Copied!`, disabled when empty (mock `navigator.clipboard.writeText`).
- `/email` page: renders a chip per member, `×` removes a recipient and drops the count, `Reset` restores, Send disabled at zero recipients. (Mock `fetchMembers` and the admin auth, following the existing page-test pattern.)
