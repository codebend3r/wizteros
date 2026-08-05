# Supabase login for the Westeroz admin pages

Date: 2026-07-23
Status: Approved (revised: single login, bridge verifies the Supabase JWT)

## Goal

Put a real identity check (Supabase Auth, email + password) in front of the
admin pages (`/manage`, `/invite`, `/email`, `/reset-user`, `/user`) as the
**single** login. The homepage (`/`) is always public.

## Revision note

The first cut layered the Supabase login in front of the pre-existing
`X-Admin-Password` gate: two prompts. That was collapsed to one: the bridge
now verifies the Supabase session directly and the admin-password gate is
deleted.

## Decisions

- **Auth method:** email + password via Supabase Auth. One login, no second
  prompt.
- **Bridge auth:** the frontend sends the Supabase access token as
  `Authorization: Bearer <jwt>`; the bridge verifies the ES256 signature
  against Supabase's JWKS (public keys, no shared secret), plus `aud`, `iss`,
  expiry, and an allowlisted email. `ADMIN_PASSWORD` and `X-Admin-Password`
  are removed entirely.
- **Entry point:** a small fixed "Admin login" button (top-right of the
  public homepage, shown only when Supabase is configured) links to `/login`,
  a dedicated page that reuses the gate and redirects to `/manage` once
  signed in.
- **Access:** only `cj.rivas.dev@gmail.com`. Enforced server-side by
  disabling public signups (nobody else can get an account) and the bridge's
  email allowlist; a client-side allowlist check backs it up.
- **Project:** Supabase `Westeroz` (`pxhbzbrwouexjhqnakcu`, ca-central-1).

## Supabase project configuration (one-time, via Management API)

1. Disable public signups (`disable_signup: true` in the auth config).
2. Create the admin user `cj.rivas.dev@gmail.com` with `email_confirm: true`
   and a generated temporary password (printed to the terminal once, never
   committed).
3. Record the project URL and publishable (anon) key for the web env vars.

## Web app changes (`web/`)

- Dependencies: `@supabase/supabase-js` and `zustand`, exact-pinned via bun.
- `src/lib/supabaseClient.ts`: singleton created from `VITE_SUPABASE_URL`
  and `VITE_SUPABASE_PUBLISHABLE_KEY`; exports `null` when either is unset.
- `src/stores/authStore.ts`: zustand store: `session`, `status`
  (`loading | signed-in | signed-out`), `signIn`, `signOut`; kept in sync
  with `supabase.auth.onAuthStateChange`.
- `src/components/LoginGate/LoginGate.tsx` (+ `.module.scss` + test);
  email/password form visually matching `AdminGate`; renders children when a
  session exists and the email is allowlisted; signs out and shows an error
  for a non-allowlisted email.
- `AdminGate` wraps its render in `LoginGate`, so all five admin pages get
  the login with zero page edits. Login first, then bridge password.
- **Unconfigured behavior:** when the Supabase env vars are unset the gate
  renders children directly: same convention as `VITE_MEMBER_URL`
  (feature dormant until configured). Local dev and CI stay green without
  secrets.
- Sign-out control added alongside the existing deauthenticate affordance.
- `.env.example` documents the two new vars; real values go in the
  gitignored `web/.env` and must be mirrored into Netlify for the deployed
  site.

## Error handling

- Bad credentials → inline error from Supabase, form stays up.
- Non-allowlisted email (defense in depth) → immediate `signOut` + error.
- Supabase unreachable → the sign-in promise rejects; error shown inline.

## Testing

Vitest + Testing Library, mocking the supabase client module:

- LoginGate shows the form when signed out.
- LoginGate renders children when a session for the allowlisted email exists.
- Bad credentials surface an error message.
- Unset env vars bypass the gate (children render).
- Existing `AdminGate` tests stay green.
