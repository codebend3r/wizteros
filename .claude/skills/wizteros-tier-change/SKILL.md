---
name: wizteros-tier-change
description: Use when adding, removing, renaming, repricing, or re-scoping a membership tier in wizteros (bronze, silver, gold, youth), when changing which libraries or servers a tier grants, when toggling a tier's downloads perk, or when changing invite/access durations. Triggers include "add a platinum tier", "change what silver can see", "rename kids to youth", "give bronze 4K", "bump gold to $25", "let silver download".
---

# Changing a wizteros Tier

## Overview

A tier is defined in **eight places across two languages**, and the two `TIER_DOWNLOADS` maps are mirrored by hand with no test asserting they agree. Missing one location produces a silent, live inconsistency: members get access their card did not promise, or a card promises access the invite never grants.

**Never change a tier in one place and assume the rest follows.** Walk the whole checklist.

## The eight locations

| # | File | What lives there |
|---|---|---|
| 1 | `stripe-bridge/stripe_bridge/tiers.py` | `TIER_DOWNLOADS` (the authoritative tier set), `_tier_wants`, `YOUTH_LIBRARIES`, `LEGACY_TIER_ALIASES` |
| 2 | `web/src/lib/adminApi.ts` | `PaidTier` union type |
| 3 | `web/src/lib/inviteRules.ts` | `PAID_TIERS`, `TIER_LABELS`, `TIER_DOWNLOADS` (hand-mirrored from #1) |
| 4 | `web/src/site.config.ts` | price, cadence, summary, feature checklist, `paymentLinkUrl` env wiring, `RawEnv` type |
| 5 | `web/src/styles/globals.scss` | `--color-<tier>` design token |
| 6 | `web/src/components/TierIcon/` | icon and colour mapping |
| 7 | Netlify dashboard env | `VITE_PAYMENT_LINK_<TIER>_URL` |
| 8 | Stripe dashboard | Payment Link carrying `metadata.tier` |

Plus tests: `stripe-bridge/tests/test_tiers.py` (which iterates `tiers.TIER_DOWNLOADS`, so it picks up a new tier automatically and will fail until rules exist for it), `test_admin.py` (parametrized over the literal tier list), and `web/src/site.config.test.ts`.

## Order of operations

Work bridge-first. The bridge is what actually grants access; the web app only describes it.

1. **`tiers.py` first.** Add the tier to `TIER_DOWNLOADS` (this map *is* the tier registry: `normalize_tier` rejects anything not in it, and `tier_server_libraries` returns nothing for unknown tiers). Then teach `_tier_wants` what the tier includes.
2. **Run `bun run test:bridge`.** `test_tiers.py` iterates the map, so a new tier without rules fails immediately. Fix before moving on.
3. **Mirror into `inviteRules.ts`** (`PAID_TIERS`, `TIER_LABELS`, `TIER_DOWNLOADS`) and widen `PaidTier` in `adminApi.ts`.
4. **Add the card** in `site.config.ts`, including the `RawEnv` key and the `env` object at the bottom of the file.
5. **Add the `--color-<tier>` token** and wire `TierIcon`.
6. **Create the Stripe Payment Link** with `metadata.tier` set to the exact lowercase tier string `normalize_tier` expects.
7. **Set the Netlify env var**, then redeploy the SPA.
8. **Run `bun run verify`.**

## Rules that must survive any change

### The private-library filter is not a tier rule

`_shareable_libraries` applies `_is_private` (the `9X.` name match) **after** and **independently of** the tier rules, so no tier rule can ever leak a private library. Add tier logic to `_tier_wants` only. Never move, weaken, or short-circuit the private filter, and never make it depend on `server_name`: it matches on name alone so it fails closed if Wizarr returns a null or renamed server.

### An empty scope must abort, not proceed

Both `_dispatch` (checkout) and `reissue_invite` check `access["library_ids"]` and raise before creating an invite. A tier whose rules resolve to nothing must keep failing loudly rather than producing an unscoped invite.

### Removing or renaming a tier needs an alias

Stripe metadata and stored SQLite rows outlive a rename. `LEGACY_TIER_ALIASES` exists because `kids` became `youth`. Any rename adds an entry there; `canonical_tier` and `normalize_tier` both route through it. Without the alias, existing members' stored tier reads as unknown and their derived library list goes empty.

### The downloads maps must agree

`inviteRules.ts` carries a comment saying it mirrors the bridge. Nothing enforces it. After editing either, diff them by eye:

```bash
grep -A6 'TIER_DOWNLOADS' stripe-bridge/stripe_bridge/tiers.py
grep -A6 'TIER_DOWNLOADS' web/src/lib/inviteRules.ts
```

Note the admin per-member downloads override in `store.member_downloads` wins over the tier default on every payload and on the next reissued invite, so a tier's downloads flag is a default, not a guarantee.

### A tier that drops a server causes an access gap

`stale_record_ids` returns every record when any current server falls outside the new scope, because Wizarr has no per-server unshare and `disable_user` severs the whole plex.tv friendship. Narrowing an existing tier's server coverage therefore forces existing members through disable-first, with a gap until they redeem. That is intended fail-closed behaviour, not a bug, but it is a member-visible consequence worth stating in the PR body.

### Youth is an exact allowlist

`YOUTH_LIBRARIES` is a frozenset of `(server_name, library_name)` pairs matching real Plex library names, which do not follow tier branding. `resolve_tier_access` logs an error when fewer libraries resolve than the allowlist holds. Renaming a library in Plex silently shrinks youth access until this set is updated.

## Copy compliance

Tier cards are user-facing payment surfaces. Per the repo's CLAUDE.md, they must use infrastructure and hosting language and must never reference content, libraries, or titles. Keep feature labels aligned across cards so the four columns stay row-aligned; `YOUTH_FEATURE_LABELS` exists purely to swap two rows while preserving that alignment.

## Verification

```bash
bun run test:bridge   # tier rules, allowlist, normalize/canonical behaviour
bun run verify        # lint, SCSS lint, format, typecheck, both suites
```

Then confirm by hand: the tier's card renders, `TierIcon` shows the right colour, and a test-mode checkout with that `metadata.tier` produces an invite scoped to the expected libraries.

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Adding to `inviteRules.ts` but not `tiers.py` | Card exists, checkout falls back to bronze |
| Adding to `tiers.py` but not `PaidTier` | Typecheck fails, or the admin tier menu omits it |
| Renaming without a `LEGACY_TIER_ALIASES` entry | Existing members read as `unknown`, libraries go empty |
| Editing one `TIER_DOWNLOADS` map only | Card promises downloads the invite does not grant |
| Forgetting `metadata.tier` on the Stripe link | Every checkout on that link silently becomes bronze |
| Forgetting the Netlify env var | Card renders with an empty `paymentLinkUrl` |
| Putting tier logic after the private filter | Private `9X.` libraries can leak |
