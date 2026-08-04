---
name: wizteros-config-drift-check
description: Use when changing any wizteros env var, invite or access duration, admin allowlist, or Netlify build variable, when adding a new `VITE_*` or bridge env var, when the UI shows a duration that contradicts what members experience, or when auditing `.env.example` against the code. Covers the four hand-mirrored sources of truth and how to reconcile them.
---

# wizteros Config Drift Check

## Overview

The same configuration value lives in up to four places, mirrored by hand, with nothing asserting they agree:

1. `.env.example` (documented as the source of truth in the README)
2. The bridge's `os.environ.get(NAME, default)` fallback
3. `web/src/lib/inviteRules.ts` hardcoded constants
4. The Netlify dashboard, and the real `.env` on the NAS

Drift here is invisible in CI and visible to paying members.

## Known drift: `INVITE_EXPIRES_DAYS`

As of this skill's writing these disagree:

| Source | Value |
|---|---|
| `.env.example` | `INVITE_EXPIRES_DAYS=7` |
| `stripe_wizarr_bridge.py`, `admin.py`, `mailer.py` defaults | `14` |
| `web/src/lib/inviteRules.ts` `INVITE_LINK_DAYS` | `14` |
| `web/src/lib/inviteRules.ts` `INVITE_GRACE_DAYS` | `14` |
| `docs/invite-flow.md` | 14-day link expiry |

If the live NAS `.env` follows `.env.example`, invite links die after 7 days while the invite email, the admin UI, and the `Invited` to `Declined Invite` status flip all say 14. Members would sit at a status of `Invited` for a week holding a dead link.

**Check the real `.env` on the NAS before assuming which value is wrong.** Then align all four sources.

## The paired values

| Value | Bridge | Web mirror | Notes |
|---|---|---|---|
| `INVITE_EXPIRES_DAYS` | invite link lifetime | `INVITE_LINK_DAYS`, `INVITE_GRACE_DAYS` | Grace deliberately matches link expiry so the status flips as the link dies |
| `ACCESS_DURATION` | days of access per payment | `ACCESS_DAYS` | Clock starts at redemption, not at payment |
| `RECONCILE_INTERVAL_SECONDS` | expiry sweep cadence | none | Bridge only |
| `MEMBERS_SNAPSHOT_INTERVAL_SECONDS` | snapshot refresh cadence | none | Bridge only |
| tier downloads | `tiers.TIER_DOWNLOADS` | `inviteRules.TIER_DOWNLOADS` | See the `wizteros-tier-change` skill |

## Where each kind of variable belongs

**Bridge runtime vars** go in `.env` on the NAS, are read by `os.environ`, and must be documented in `.env.example`. Vars read at import time with `os.environ["NAME"]` (no default) crash the container on boot when unset; vars read with `os.environ.get` degrade silently. Choose deliberately: `STRIPE_API_KEY`, `WIZARR_BASE_URL`, and `PUBLIC_INVITE_BASE` are required-at-boot on purpose.

**Web build vars** must be prefixed `VITE_`, added to the `RawEnv` type in `site.config.ts`, added to the `env` object at the bottom of that file, and set in the Netlify dashboard. They are baked in at build time, so changing one requires a redeploy, not a restart.

**Never put a secret in a `VITE_*` var.** It ships to the browser. `netlify.toml` already carries `SECRETS_SCAN_OMIT_KEYS = "SMTP_USER,FROM_ADDR"` because those two hold the public contact email; do not extend that list to silence a scan on something actually secret.

## Checklist for adding or changing a value

- [ ] Update `.env.example` with the value and a comment explaining it
- [ ] Check the code default matches, or is a deliberate safer fallback
- [ ] Update any web mirror in `inviteRules.ts` or `site.config.ts`
- [ ] Update the docs that state the number (`docs/invite-flow.md` quotes both durations)
- [ ] For `VITE_*`: add to `RawEnv`, the `env` object, and Netlify
- [ ] For a bridge var: set it in the real `.env` on the NAS, then restart the container
- [ ] `bun run verify`

## Auditing

```bash
# every env var the bridge reads
grep -rhoE 'os\.environ(\.get\(|\[)"[A-Z_]+"' stripe-bridge/stripe_bridge/ | grep -oE '"[A-Z_]+"' | sort -u

# every var documented in the example file
grep -oE '^[A-Z_]+=' .env.example | tr -d '=' | sort -u

# every VITE_ var referenced by the web app
grep -rhoE 'VITE_[A-Z_]+' web/src/ | sort -u
```

Diff the first two lists. A var in the code but not the example is undocumented; a var in the example but not the code is dead.

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Changing a duration in the web app only | UI promises a window the bridge does not honour |
| Adding a `VITE_*` var without the `RawEnv` entry | Typecheck passes, value is always undefined at runtime |
| Adding a `VITE_*` var without setting it in Netlify | Renders empty in production, fine locally |
| Assuming `.env.example` reflects production | It is the documented default, not the deployed value |
| Putting a secret in a `VITE_*` var | Secret ships in the browser bundle |
