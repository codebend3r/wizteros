# Admin pages: `/manage` + `/reset-user`

Date: 2026-07-17
Status: Approved (design), pending implementation plan

## Goal

Give the operator two password-gated admin pages in the `westeroz-web` app:

- **`/manage`** — a paginated table of all members with a per-row Invite action or
  a "Subscribed" label.
- **`/reset-user`** — look a member up by email and apply pre-baked tier / expiry
  presets.

Both talk to Wizarr, but only ever through the existing `stripe-bridge` service so
the Wizarr admin key never reaches the browser.

## Constraints discovered up front

- `westeroz-web` is a static Vite/React 18 SPA on Netlify (`bun run build` → `dist`),
  with **no router today**.
- The live Wizarr `GET /api/users` returns only:
  `id, username, email, server, server_type, expires, created_at`.
  There is **no** first/last name, tier, or download flag.
  - "Member" name = the Plex `username`.
  - `expires: null` = no expiry.
- That call takes **~14s** and returns **237 records — one per person per server**
  (5 servers), not 237 people.
- Tier is a Stripe-metadata concept; nothing stores it per user today.
  `allow_downloads` is derivable from tier (`tiers.TIER_DOWNLOADS`: Gold/Kids = true,
  Bronze/Silver = false).
- Wizarr **cannot** re-scope an existing member's libraries in place — disabling a
  user severs the whole plex.tv friendship (see `wizarr-disable-is-account-wide`
  memory and the bridge's reset-and-rejoin note). Re-scoping = disable + re-invite.
  Expiry changes _are_ in-place (`PUT /api/users/{id}/update-expiry`).

## Decisions (locked)

1. **Backend = the FastAPI bridge.** New password-guarded admin endpoints on the
   existing bridge (Meleys), reached by the SPA over Tailscale Funnel. Key stays put,
   no serverless timeout limit, reuses the current Funnel mount.
2. **Reset-user tier buttons = reset + re-invite.** Disable the member's existing
   records and issue a fresh tier-scoped invite link to re-redeem.
3. **Tier column = stored in the bridge.** Add a `tier` column to `customer_map`,
   written at checkout; join to Wizarr users by email. Pre-existing members read
   `"unknown"` until their next Stripe event.
4. **Table = one row per person.** Dedupe by email (fallback username); aggregate
   servers + expiry. `subscribed` = has any non-null expiry.

## Architecture

```
Browser (SPA /manage, /reset-user)
  │  X-Admin-Password header on every call
  ▼
Tailscale Funnel  (/stripe/* → bridge, prefix stripped)
  ▼
stripe-bridge admin API  ──uses──▶ WizarrClient ──▶ Wizarr /api/*
  │
  └─ reads tier from customer_map (bridge SQLite)
```

### Web

- Add **`react-router-dom` v7** (declarative `BrowserRouter`). Routes:
  `/` (existing landing), `/manage`, `/reset-user`.
- Netlify SPA fallback: `web/public/_redirects` → `/*  /index.html  200`.
- New units (each SCSS-module styled, using `styles/globals.scss` tokens):
  - `components/AdminGate/AdminGate.tsx` — shared password login wrapper.
  - `pages/Manage/Manage.tsx` + a presentational `MembersTable` with client pagination.
  - `pages/ResetUser/ResetUser.tsx`.
  - `lib/adminApi.ts` — typed fetch wrapper that injects `X-Admin-Password` and
    reads `VITE_ADMIN_API_BASE`.
- New build-time env: `VITE_ADMIN_API_BASE`
  (prod `https://meleys.tail5586d4.ts.net/stripe`). Add to `web/.env.example`.

### Auth model

- Password lives only on the bridge as `ADMIN_PASSWORD` (default `morty8229!`).
- `AdminGate` renders one password field; on submit the value is kept in
  `sessionStorage` and sent as `X-Admin-Password` on every admin request.
- The bridge validates the header on **every** admin endpoint via a FastAPI
  dependency; mismatch → `401`. The SPA clears storage and returns to the gate on 401.
- No JWT/session. Deliberately minimal ("temporary" per the request).

### Bridge admin API

- Mounted at `/admin/*`, and aliased at `/stripe/admin/*` (mirrors the existing
  dual `/webhook` + `/stripe/webhook` decorators) so it works both behind Funnel
  (prefix stripped) and on direct/local calls.
- **CORS**: FastAPI `CORSMiddleware` allowing origins from a new
  `ADMIN_ALLOWED_ORIGINS` env (comma-separated; the Netlify prod URL +
  `http://localhost:5173` for dev), methods `GET, POST`, the `X-Admin-Password`
  and `Content-Type` headers.
- New env added to `.env.example`: `ADMIN_PASSWORD`, `ADMIN_ALLOWED_ORIGINS`.
- **Dockerfile**: add any new `.py` modules to the explicit `COPY` line (per
  CLAUDE.md — new modules must be listed).

#### Endpoints (all require `X-Admin-Password`)

| Method + path                | Body / query      | Behaviour                                                                                                                                                               |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/members`         | —                 | Wizarr users → dedupe by person → join tier → derive downloads. Returns `Member[]`.                                                                                     |
| `GET /admin/member`          | `?email=`         | Same shape for one email; `404` if no record.                                                                                                                           |
| `POST /admin/reset-expiry`   | `{ email, days }` | `days: number \| null`; `null` clears expiry. `update-expiry` on every record for that email. Returns `{ updated: number, expires: string \| null }`.                   |
| `POST /admin/reissue-invite` | `{ email, tier }` | Disable every existing record for that email, then create a tier-scoped invite (fail-closed, excludes `9X.` privates). Returns `{ url, code, tier, disabled: number }`. |

`Member` shape:

```ts
type Member = {
  member: string // Plex username
  email: string
  tier: 'bronze' | 'silver' | 'gold' | 'kids' | 'unknown'
  downloads: boolean | null // derived from tier; null when tier unknown
  expires: string | null // ISO; latest across the person's records
  servers: string[] // server names the person appears on
  subscribed: boolean // any non-null expiry
}
```

Dedupe key = lowercased email when present, else lowercased username.
`expires` = max non-null expiry across the person's records.

### Bridge internals (reuse, don't duplicate)

- `WizarrClient`: add `list_users()` (calls `_users({})` → all records).
- `store.py`: add `tier` column to `customer_map` (`init_db` creates it; keep it
  additive/idempotent since the table already exists in prod). `upsert_pending`
  gains a `tier` arg. Add `tiers_by_email(path) -> dict[str, str]` for the join.
- `stripe_wizarr_bridge.py` checkout handler: pass the already-computed `tier` into
  `upsert_pending`.
- Admin invite reuse: `reissue-invite` uses `tiers.resolve_tier_access` +
  `client.create_invite` (same path as the webhook), and disables existing records
  found by `client.find_user_ids_by_email`.
- Put the admin routes/deps in a **separate `admin.py`** (FastAPI `APIRouter`) to
  keep the bridge's single-purpose webhook file focused; wire it in with
  `app.include_router(...)` twice (bare + `/stripe` prefix).

## Page behaviours

### `/manage`

- On mount (post-gate) fetch `GET /admin/members`, show a loading state (call is
  ~14s), then a client-paginated table (page size **25**).
- Columns: **Member**, **Email**, **Tier**, **Downloads** (✓ / ✗, `—` when
  `downloads === null`), **Expiry** (formatted date or "—").
- Per-row action: `subscribed` → **"Subscribed"** text label (no button);
  otherwise an **Invite** button.
- **Invite button** → `POST /admin/reissue-invite { email, tier: 'bronze' }`,
  then surface the returned link to copy. Bronze is the default scope (fail-closed,
  base tier). _(Open to a tier picker later; Bronze default confirmed for v1.)_
  Note: for a no-expiry member this still disables + reissues (consistent with the
  reset model); the row copy makes clear a link was generated.
- Pagination is purely client-side over the fetched array (prev/next + page count).

### `/reset-user`

- Email input with **client-side email-format validation** (block the lookup until
  it looks like an email).
- Submit → `GET /admin/member?email=`. Not found → inline "no member" message.
- On match, show the member summary + two preset groups:
  - **Tier:** Bronze / Silver / Gold / Kids → `reissue-invite` → show the re-redeem
    link, labeled "the member must open this link to finish." (disable + re-invite)
  - **Expiry:** No expiry / 15d / 35d / 70d → `reset-expiry` (`days: null|15|35|70`)
    → inline success. Instant, in-place.
- Each action shows pending / success / error inline.

## Testing

- **Bridge (pytest, `responses` mock like existing tests):**
  - `store`: tier column persists via `upsert_pending`; `tiers_by_email` maps
    correctly; `init_db` is idempotent on an existing table.
  - `admin`: password dependency returns 401 without / with a wrong header;
    `members` dedupes 5-server records into one person and joins tier + derives
    downloads; `member` 404s on miss; `reset-expiry` clears with `null` and sets
    with a day count; `reissue-invite` disables existing ids then creates a
    tier-scoped invite (assert private `9X.` libraries excluded).
- **Web (vitest + testing-library, mock `fetch`):**
  - `AdminGate`: hides children until the password is entered; passes header through.
  - `MembersTable`: renders Subscribed label vs Invite button by `subscribed`;
    pagination slices pages; downloads renders ✓/✗/—.
  - `ResetUser`: rejects non-email input; renders presets after a match; calls the
    right endpoint per button.

## Open risk to verify during implementation

- **Clearing expiry:** the "No expiry" preset assumes `PUT /api/users/{id}/update-expiry`
  accepts `null` (or empty) to clear. The bridge only ever sets absolute ISO values
  today. The plan must probe the live endpoint first; if `null` isn't accepted,
  find Wizarr's actual clear mechanism (or drop the "No expiry" preset).

## Known limitations (accepted)

- No first/last name in Wizarr — "Member" is the Plex handle.
- Tier is best-effort by email join (Stripe email may differ from Plex email);
  pre-existing members read "unknown" until a future Stripe event.
- Single shared weak password, server-validated — fine for "temporary," not for
  real multi-user admin.
- `/manage` waits on the ~14s Wizarr call each load (no caching in v1).

## Out of scope (v1)

- Real user accounts / roles / sessions.
- Editing names or arbitrary Wizarr fields.
- Server-side pagination or caching of the member list.
- Backfilling tier for pre-existing members.
