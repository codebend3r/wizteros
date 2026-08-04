---
name: stripe-bridge-migration
description: Use when adding a column or table to the wizteros stripe-bridge SQLite database, changing its schema, or writing a one-time data backfill script. Triggers include "add a field to the customer map", "store X per member", "new table in the bridge", "backfill existing members", "migrate the bridge DB". Covers the additive-only startup migration pattern and the dry-run backfill convention.
---

# stripe-bridge SQLite Migrations

## Overview

The bridge has no migration framework. `store.init_db` runs on **every container start** and must be safe every time against a live production database holding real member state. Three column migrations already exist and set the pattern.

**The production DB at `stripe-bridge-data/bridge.db` is never rsynced and has no automated backup.** A destructive migration loses every member tag, note, event, and the processed-events table.

## The pattern

### New table

Add a module-level `_<NAME>_SCHEMA` constant using `CREATE TABLE IF NOT EXISTS`, then execute it in `init_db` alongside the others.

```python
_REFERRALS_SCHEMA = """
CREATE TABLE IF NOT EXISTS referrals (
    email      TEXT PRIMARY KEY,
    referrer   TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""
```

`IF NOT EXISTS` makes it idempotent. No guard function is needed.

### New column on an existing table

`CREATE TABLE IF NOT EXISTS` will not alter a table that already exists, so an added column needs its own guard. Follow the three existing ones exactly:

```python
def _ensure_referrer_column(c: sqlite3.Connection) -> None:
    """Add customer_map.referrer to a pre-referral prod DB; no-op once present."""
    cols = [row["name"] for row in c.execute("PRAGMA table_info(customer_map)")]
    if "referrer" not in cols:
        c.execute("ALTER TABLE customer_map ADD COLUMN referrer TEXT")
```

Then call it from `init_db` **after** the `CREATE TABLE` statements and after the existing `_ensure_*` calls. Order matters only in that tables must exist first.

Existing examples: `_ensure_tier_column`, `_ensure_invited_at_column`, `_ensure_subscribed_column`.

## Rules

### Additive only

`ALTER TABLE ... ADD COLUMN` and `CREATE TABLE IF NOT EXISTS` only. Never `DROP`, never `ALTER ... DROP COLUMN`, never a rename-and-copy rebuild in `init_db`. A retired column stays in place, unused. The cost of a dead column is nothing; the cost of a migration that fires twice on a restart loop is real member data.

### Every migration must be a no-op on second run

`init_db` runs on every boot, and the container has `restart: unless-stopped`. A crash loop runs it repeatedly. `PRAGMA table_info` guards and `IF NOT EXISTS` both satisfy this. A bare `ALTER TABLE` does not: it raises on the second run and takes the bridge down.

### New columns need a safe default

Prefer nullable with no default, and handle `None` at the read site. When a non-null default is genuinely needed, note why. `subscribed` uses `INTEGER NOT NULL DEFAULT 0` deliberately: it is the durable record of a confirmed Stripe payment and must never default to true, because `deriveStatus` in the web app keys `Subscribed Monthly` off it.

### Emails are the join key and are lowercased

Most tables key on `email` and callers lowercase before writing. `all_member_tags`, `all_member_downloads`, and `all_customer_rows` all return lowercased keys. A new email-keyed table must do the same or lookups silently miss.

### Adding a field means updating the payload

A new per-member column usually needs to reach the UI. That means `admin.py` (`_with_overrides` or `_dedupe_members`), the `Member` type in `web/src/lib/adminApi.ts`, and any component reading it. Add a bridge test in `tests/test_store.py` and an admin test in `tests/test_admin.py`.

## Backfill scripts

Migrations create structure. Populating existing rows is a separate one-time script in `stripe-bridge/scripts/`, following `backfill_invited_expiry.py`:

- Module docstring stating exactly what it does, what it skips, and the run command with env vars.
- `--dry-run` flag, and a summary printed in both modes. **Always run `--dry-run` first and read the output.**
- Idempotent and safe to re-run.
- Explicit skip rules for members it must not touch. The existing script skips anyone tagged `vip` (VIP access is never time-boxed) and anyone already carrying a confirmed payment.
- The `sys.path` preamble so both the checkout layout and the flat `/app` image layout import cleanly.
- Config from the bridge's own env vars (`MAP_DB_PATH`, `WIZARR_BASE_URL`, `WIZARR_API_KEY`), never hardcoded.
- A companion test in `tests/`, as `test_backfill.py` does.

Ordering matters when a backfill interacts with new logic. The existing script's docstring warns to deploy the payment-flag changes first, because the old status logic would have read backfilled members as `Subscribed Monthly` the moment they got an expiry. State that ordering in the docstring when it applies.

## Deploying a migration

1. `bun run test:bridge`
2. Copy `stripe-bridge-data/bridge.db` off the NAS before applying anything that touches existing rows.
3. Deploy per the `wizteros-deploy` skill. `init_db` runs on container start, so `docker compose up -d --build` applies it.
4. Check the logs came up clean, then run any backfill with `--dry-run` first.

## Red Flags: STOP

- A `DROP`, `DELETE`, or destructive `UPDATE` inside `init_db`
- `ALTER TABLE` with no `PRAGMA table_info` guard
- A backfill without `--dry-run`
- A backfill with no skip rule for `vip`-tagged members
- Changing the meaning of `subscribed` rather than adding a new column
- Applying a migration without a copy of the production DB

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Adding a column to `_SCHEMA` only | Fresh DBs get it, production never does |
| Unguarded `ALTER TABLE` | Bridge crash-loops on second boot |
| Not lowercasing an email key | Lookups miss for mixed-case addresses |
| Non-null default on a payment-ish flag | Members read as subscribed without paying |
| Backfill with no skip for VIPs | Time-boxes access that is meant to be permanent |
