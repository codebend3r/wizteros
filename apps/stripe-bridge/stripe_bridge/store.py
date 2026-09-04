import logging
import sqlite3
from datetime import datetime, timezone

log = logging.getLogger("bridge.store")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    tier               TEXT,
    subscribed         INTEGER NOT NULL DEFAULT 0
)
"""

_EVENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY
)
"""

_NOTES_SCHEMA = """
CREATE TABLE IF NOT EXISTS member_notes (
    email TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT ''
)
"""

_TAGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS member_tags (
    email TEXT PRIMARY KEY,
    tag   TEXT NOT NULL
)
"""

_DOWNLOADS_SCHEMA = """
CREATE TABLE IF NOT EXISTS member_downloads (
    email TEXT PRIMARY KEY,
    allow INTEGER NOT NULL
)
"""

_EVENT_LOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS event_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    email  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
)
"""

# One row per checkout session, written the moment its invite exists. A Stripe
# retry of the same session reads this instead of minting a second invite.
_SESSION_INVITES_SCHEMA = """
CREATE TABLE IF NOT EXISTS session_invites (
    session_id  TEXT PRIMARY KEY,
    invite_code TEXT NOT NULL,
    emailed     INTEGER NOT NULL DEFAULT 0
)
"""


_BASELINE_INVITES_SCHEMA = """
CREATE TABLE IF NOT EXISTS baseline_invites (
    code       TEXT PRIMARY KEY,
    tier       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
)
"""


# An admin's statement that two addresses are one person. The automatic join
# (a redeemed invite's used_by) answers only for members who actually redeemed
# the invite their checkout issued; someone who re-subscribes under a re-typed
# address while already holding access never redeems the new one, so nothing
# ties the paying customer to the Plex account they watch with. Keyed on the
# Stripe address because that is the row that must stop standing on its own;
# one person can pay under several addresses, so plex_email is not unique.
_MEMBER_LINKS_SCHEMA = """
CREATE TABLE IF NOT EXISTS member_links (
    stripe_email TEXT PRIMARY KEY,
    plex_email   TEXT NOT NULL
)
"""


def _conn(path: str) -> sqlite3.Connection:
    """Open the SQLite file; the Row factory makes rows dict-like (row["email"])."""
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


def _ensure_tier_column(c: sqlite3.Connection) -> None:
    """Add customer_map.tier to a pre-tier prod DB; no-op once present."""
    cols = [row["name"] for row in c.execute("PRAGMA table_info(customer_map)")]
    if "tier" not in cols:
        c.execute("ALTER TABLE customer_map ADD COLUMN tier TEXT")


def _ensure_invited_at_column(c: sqlite3.Connection) -> None:
    """Add customer_map.invited_at to a pre-grace-period prod DB; no-op once present."""
    cols = [row["name"] for row in c.execute("PRAGMA table_info(customer_map)")]
    if "invited_at" not in cols:
        c.execute("ALTER TABLE customer_map ADD COLUMN invited_at TEXT")


def _ensure_subscribed_column(c: sqlite3.Connection) -> None:
    """Add customer_map.subscribed to a pre-payment-signal prod DB; no-op once present.

    The flag is the durable record of a confirmed Stripe payment — set by the
    webhooks, not inferred from a Wizarr expiry — so a member can carry an
    expiry (a manual access deadline) without reading as a paying subscriber.
    """
    cols = [row["name"] for row in c.execute("PRAGMA table_info(customer_map)")]
    if "subscribed" not in cols:
        c.execute("ALTER TABLE customer_map ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 0")


def _ensure_payment_state_column(c: sqlite3.Connection) -> None:
    """Add customer_map.payment_state to a pre-dunning prod DB; no-op once present.

    Stripe keeps charging a failed subscription for weeks before it gives up
    and deletes it. Until this column existed the bridge heard nothing in
    between: `subscribed` stayed 1 from the last good payment, the member read
    "Subscribed Monthly" in the admin UI, and the first visible sign of trouble
    was their access expiring out from under them. NULL means "no problem
    known"; "past_due" means Stripe has a failed charge outstanding.
    """
    cols = [row["name"] for row in c.execute("PRAGMA table_info(customer_map)")]
    if "payment_state" not in cols:
        c.execute("ALTER TABLE customer_map ADD COLUMN payment_state TEXT")


def init_db(path: str) -> None:
    """Create the tables if missing and backfill the tier column; safe every startup."""
    with _conn(path) as c:
        c.execute(_SCHEMA)
        c.execute(_EVENTS_SCHEMA)
        c.execute(_NOTES_SCHEMA)
        c.execute(_TAGS_SCHEMA)
        c.execute(_DOWNLOADS_SCHEMA)
        c.execute(_EVENT_LOG_SCHEMA)
        c.execute(_SESSION_INVITES_SCHEMA)
        c.execute(_BASELINE_INVITES_SCHEMA)
        c.execute(_MEMBER_LINKS_SCHEMA)
        _ensure_tier_column(c)
        _ensure_invited_at_column(c)
        _ensure_subscribed_column(c)
        _ensure_payment_state_column(c)


_ADMIN_KEY_PREFIX = "admin:"


def upsert_pending(path: str, stripe_customer_id: str, email: str,
                   invite_code: str, tier: str | None = None) -> None:
    """Insert or update ("upsert") the customer -> email + invite code + tier mapping.

    Stamps invited_at with the current UTC time — every upsert corresponds to
    a freshly issued invite, and the stamp anchors the grace-period status.
    Marks the member subscribed: this is the confirmed-payment path (a Stripe
    checkout completed), which is what "Subscribed Monthly" keys off.
    """
    invited_at = datetime.now(timezone.utc).isoformat()
    with _conn(path) as c:
        # One row per person: a real Stripe mapping supersedes any placeholder
        # left by an admin-issued invite for the same email.
        c.execute(
            "DELETE FROM customer_map WHERE stripe_customer_id = ?",
            (_ADMIN_KEY_PREFIX + email.lower(),),
        )
        c.execute(
            """
            INSERT INTO customer_map
                (stripe_customer_id, email, invite_code, tier, invited_at, subscribed)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(stripe_customer_id)
            DO UPDATE SET email = excluded.email,
                          invite_code = excluded.invite_code,
                          tier = excluded.tier,
                          invited_at = excluded.invited_at,
                          subscribed = 1
            """,
            (stripe_customer_id, email, invite_code, tier, invited_at),
        )


def upsert_pending_by_email(path: str, email: str, invite_code: str,
                            tier: str | None = None) -> None:
    """Record an admin-issued invite for an email with no known Stripe customer id.

    Re-points every existing row for the email (case-insensitive) at the new
    invite code + tier and restarts the invited_at grace clock; otherwise
    inserts a placeholder keyed "admin:<email>" so the member stays listed on
    /manage until they redeem.
    """
    invited_at = datetime.now(timezone.utc).isoformat()
    with _conn(path) as c:
        cur = c.execute(
            "UPDATE customer_map SET invite_code = ?, tier = ?, invited_at = ? "
            "WHERE lower(email) = lower(?)",
            (invite_code, tier, invited_at, email),
        )
        if cur.rowcount == 0:
            c.execute(
                "INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier, invited_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (_ADMIN_KEY_PREFIX + email.lower(), email, invite_code, tier, invited_at),
            )


def stamp_invited(path: str, email: str) -> None:
    """Record that an invite was sent to an email: set invited_at = now only.

    Leaves tier, invite code, and the subscribed flag untouched — for members
    invited manually outside the bridge (no bridge-issued code). Inserts an
    admin-keyed placeholder (subscribed defaults to 0) when no row exists yet, so
    the member reads as "Invited" on /admin/members while the grace clock runs.
    """
    invited_at = datetime.now(timezone.utc).isoformat()
    with _conn(path) as c:
        cur = c.execute(
            "UPDATE customer_map SET invited_at = ? WHERE lower(email) = lower(?)",
            (invited_at, email),
        )
        if cur.rowcount == 0:
            c.execute(
                "INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier, invited_at) "
                "VALUES (?, ?, NULL, NULL, ?)",
                (_ADMIN_KEY_PREFIX + email.lower(), email, invited_at),
            )


def set_tier(path: str, email: str, tier: str) -> None:
    """Hard-set the recorded tier for an email, leaving its invite code alone.

    Updates every row for the email (case-insensitive); inserts an admin-keyed
    placeholder when the bridge has no row yet so the member shows up on
    /admin/members with the forced tier.
    """
    with _conn(path) as c:
        cur = c.execute(
            "UPDATE customer_map SET tier = ? WHERE lower(email) = lower(?)",
            (tier, email),
        )
        if cur.rowcount == 0:
            c.execute(
                "INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier) "
                "VALUES (?, ?, NULL, ?)",
                (_ADMIN_KEY_PREFIX + email.lower(), email, tier),
            )


def set_subscribed(path: str, email: str, value: bool) -> None:
    """Set the confirmed-payment flag on every row for an email (case-insensitive).

    Driven by the Stripe webhooks — a paid invoice sets it, a deleted
    subscription clears it. No-op when the bridge has no row for the email yet
    (a renewal always follows the checkout that created the row).
    """
    with _conn(path) as c:
        c.execute(
            "UPDATE customer_map SET subscribed = ? WHERE lower(email) = lower(?)",
            (int(value), email),
        )


def set_payment_state(path: str, email: str, state: str | None) -> None:
    """Record (or clear) an outstanding Stripe payment problem for an email.

    "past_due" is written by invoice.payment_failed and by a subscription that
    Stripe moves to past_due/unpaid; None is written the moment an invoice for
    them is paid. Deliberately separate from `subscribed`: a member in dunning
    has still paid for the period they are in, so their access is untouched.
    What changes is that the admin UI stops calling them healthy.
    """
    with _conn(path) as c:
        c.execute(
            "UPDATE customer_map SET payment_state = ? WHERE lower(email) = lower(?)",
            (state, email),
        )


def is_event_processed(path: str, event_id: str) -> bool:
    """Read-only check for whether event_id has already been marked processed."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT 1 FROM processed_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
    return row is not None


def mark_event_processed(path: str, event_id: str) -> bool:
    """Record event_id. Return True if newly recorded, False if already seen."""
    with _conn(path) as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)",
            (event_id,),
        )
        return cur.rowcount > 0


def get_session_invite(path: str, session_id: str) -> dict | None:
    """The invite already issued for a checkout session, or None if there is none.

    Returns {"invite_code", "emailed"} so a retry can tell "invite exists and
    the member has the link" from "invite exists but the email never went out".
    """
    with _conn(path) as c:
        row = c.execute(
            "SELECT invite_code, emailed FROM session_invites WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    return {"invite_code": row["invite_code"], "emailed": bool(row["emailed"])} if row else None


def record_session_invite(path: str, session_id: str, invite_code: str) -> None:
    """Bind a checkout session to the invite just created for it (not yet emailed).

    Written immediately after create_invite so that a crash anywhere later in
    the handler can never cost the member a second invite on Stripe's retry.
    """
    with _conn(path) as c:
        c.execute(
            """
            INSERT INTO session_invites (session_id, invite_code, emailed) VALUES (?, ?, 0)
            ON CONFLICT(session_id) DO UPDATE SET invite_code = excluded.invite_code
            """,
            (session_id, invite_code),
        )


def mark_session_invite_emailed(path: str, session_id: str) -> None:
    """Record that the session's invite link actually reached the member."""
    with _conn(path) as c:
        c.execute(
            "UPDATE session_invites SET emailed = 1 WHERE session_id = ?",
            (session_id,),
        )


def customer_ids_for_email(path: str, email: str) -> list[str]:
    """Real Stripe customer ids recorded for an email, case-insensitive.

    Admin-issued placeholder rows (keyed "admin:<email>") are excluded — they
    have no Stripe side to act on.
    """
    with _conn(path) as c:
        rows = c.execute(
            "SELECT stripe_customer_id FROM customer_map WHERE lower(email) = lower(?)",
            (email,),
        ).fetchall()
    return [
        row["stripe_customer_id"] for row in rows
        if not row["stripe_customer_id"].startswith(_ADMIN_KEY_PREFIX)
    ]


def get_mapping(path: str, stripe_customer_id: str) -> dict | None:
    """Fetch a customer's mapping as a plain dict, or None if unknown."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT stripe_customer_id, email, invite_code "
            "FROM customer_map WHERE stripe_customer_id = ?",
            (stripe_customer_id,),
        ).fetchone()
    return dict(row) if row else None


def tiers_by_email(path: str) -> dict[str, str]:
    """Map lowercased email -> tier for every mapping that has a tier recorded."""
    with _conn(path) as c:
        rows = c.execute(
            "SELECT email, tier FROM customer_map WHERE tier IS NOT NULL AND email IS NOT NULL"
        ).fetchall()
    return {row["email"].lower(): row["tier"] for row in rows}


def get_member_notes(path: str, email: str) -> str:
    """The admin's free-form notes for an email; empty string when none saved."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT notes FROM member_notes WHERE email = ?",
            (email.lower(),),
        ).fetchone()
    return row["notes"] if row else ""


def set_member_notes(path: str, email: str, notes: str) -> None:
    """Save (overwrite) the admin's notes for an email; keyed lowercased."""
    with _conn(path) as c:
        c.execute(
            """
            INSERT INTO member_notes (email, notes) VALUES (?, ?)
            ON CONFLICT(email) DO UPDATE SET notes = excluded.notes
            """,
            (email.lower(), notes),
        )


def set_member_tag(path: str, email: str, tag: str | None) -> None:
    """Save the manual designation for an email (keyed lowercased); None clears it."""
    with _conn(path) as c:
        if tag is None:
            c.execute("DELETE FROM member_tags WHERE email = ?", (email.lower(),))
        else:
            c.execute(
                """
                INSERT INTO member_tags (email, tag) VALUES (?, ?)
                ON CONFLICT(email) DO UPDATE SET tag = excluded.tag
                """,
                (email.lower(), tag),
            )


def get_member_tag(path: str, email: str) -> str | None:
    """The member's manual designation ("vip"/"hvu"), or None when untagged."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT tag FROM member_tags WHERE email = ?",
            (email.lower(),),
        ).fetchone()
    return row["tag"] if row else None


def set_member_link(path: str, *, stripe_email: str, plex_email: str | None) -> None:
    """Record that `stripe_email` bills for the person watching as `plex_email`.

    A None `plex_email` clears the link, which puts the Stripe address back on
    the members list as its own row. Both are stored lowercased, the same key
    the customer map and the Wizarr user join use.
    """
    with _conn(path) as c:
        if plex_email is None:
            c.execute("DELETE FROM member_links WHERE stripe_email = ?",
                      (stripe_email.lower(),))
        else:
            c.execute(
                """
                INSERT INTO member_links (stripe_email, plex_email) VALUES (?, ?)
                ON CONFLICT(stripe_email) DO UPDATE SET plex_email = excluded.plex_email
                """,
                (stripe_email.lower(), plex_email.lower()),
            )


def get_member_link(path: str, stripe_email: str) -> str | None:
    """The Plex address this Stripe address pays for, or None when unlinked."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT plex_email FROM member_links WHERE stripe_email = ?",
            (stripe_email.lower(),),
        ).fetchone()
    return row["plex_email"] if row else None


def all_member_links(path: str) -> dict[str, str]:
    """Map lowercased Stripe address -> the Plex address it pays for."""
    with _conn(path) as c:
        rows = c.execute("SELECT stripe_email, plex_email FROM member_links").fetchall()
    return {row["stripe_email"]: row["plex_email"] for row in rows}


def all_member_tags(path: str) -> dict[str, str]:
    """Map lowercased email -> manual tag for every tagged member."""
    with _conn(path) as c:
        rows = c.execute("SELECT email, tag FROM member_tags").fetchall()
    return {row["email"]: row["tag"] for row in rows}


def set_member_downloads(path: str, email: str, allow: bool) -> None:
    """Save the admin's downloads override for an email (keyed lowercased)."""
    with _conn(path) as c:
        c.execute(
            """
            INSERT INTO member_downloads (email, allow) VALUES (?, ?)
            ON CONFLICT(email) DO UPDATE SET allow = excluded.allow
            """,
            (email.lower(), int(allow)),
        )


def get_member_downloads(path: str, email: str) -> bool | None:
    """The downloads override for an email; None when the tier default applies."""
    with _conn(path) as c:
        row = c.execute(
            "SELECT allow FROM member_downloads WHERE email = ?",
            (email.lower(),),
        ).fetchone()
    return bool(row["allow"]) if row else None


def all_member_downloads(path: str) -> dict[str, bool]:
    """Map lowercased email -> downloads override for every overridden member."""
    with _conn(path) as c:
        rows = c.execute("SELECT email, allow FROM member_downloads").fetchall()
    return {row["email"]: bool(row["allow"]) for row in rows}


def record_event(path: str, email: str, action: str, detail: str = "") -> None:
    """Append one action to a member's history (keyed lowercased email).

    Never raises: the history is an audit trail, and a logging failure must
    not break or retry the action it records (e.g. a Stripe webhook).
    """
    try:
        with _conn(path) as c:
            c.execute(
                "INSERT INTO event_log (at, email, action, detail) VALUES (?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat(), email.lower(), action, detail),
            )
    except Exception:
        log.exception("event log write failed for %s / %s", email, action)


def events_for_email(path: str, email: str, limit: int = 100) -> list[dict]:
    """A member's action history, newest first."""
    with _conn(path) as c:
        rows = c.execute(
            "SELECT id, at, email, action, detail FROM event_log "
            "WHERE email = ? ORDER BY id DESC LIMIT ?",
            (email.lower(), limit),
        ).fetchall()
    return [dict(row) for row in rows]


def all_events(path: str, limit: int = 50_000) -> list[dict]:
    """The whole action history across every member, newest first.

    Feeds the income page, which reads signups, tier changes and
    cancellations off it to draw the months; per-member reads stay on
    events_for_email. The cap is a safety valve, not a page size: the log
    grows by a few rows per member per month, so it is decades away, and
    when it is reached the oldest rows (the earliest signups) go first.
    """
    with _conn(path) as c:
        rows = c.execute(
            "SELECT id, at, email, action, detail FROM event_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def all_customer_tiers(path: str) -> dict[str, str | None]:
    """Every customer's lowercased email -> tier (tier may be None).

    Unlike tiers_by_email, this keeps rows with no tier yet, so the admin table
    can list every subscriber the bridge knows about — including people who paid
    but have not redeemed their Wizarr invite — not just those with Plex records.
    """
    with _conn(path) as c:
        rows = c.execute(
            "SELECT email, tier FROM customer_map WHERE email IS NOT NULL"
        ).fetchall()
    return {row["email"].lower(): row["tier"] for row in rows}


def all_customer_rows(path: str) -> dict[str, dict]:
    """Every customer's lowercased email -> {"customer_id", "invite_code", "tier", "invited_at", "subscribed"}.

    Exactly one entry per email: when several customer rows share one, the
    newest real Stripe customer wins (see the ordering below).

    invite_code, tier, and invited_at may be None. The invited_at stamp lets
    the admin UI age a pending invite into the "Declined Invite" status once
    the grace period lapses; subscribed is the confirmed-payment flag that
    drives "Subscribed Monthly" independently of any Wizarr expiry;
    invite_code feeds the reconcile sweep's fallback for members whose Plex
    email differs from the Stripe email. customer_id is the real Stripe id
    (cus_...) or None; admin-issued placeholder rows are keyed
    "admin:<email>" and must never leak as a customer id.
    """
    # One entry per email, and WHICH row answers must not depend on SQLite's
    # unordered scan. A member who checked out more than once has a row per
    # attempt, all sharing an email. subscribed and invited_at cannot break the
    # tie (both are written across every row for the email), so order by what
    # does vary: a real cus_ row outranks an "admin:<email>" placeholder, and
    # among real ones the newest checkout is the live one. Best row sorts last,
    # which is the one the comprehension below keeps.
    with _conn(path) as c:
        rows = c.execute(
            "SELECT stripe_customer_id, email, invite_code, tier, invited_at, subscribed, "
            "payment_state FROM customer_map WHERE email IS NOT NULL "
            "ORDER BY (CASE WHEN stripe_customer_id LIKE 'cus\\_%' ESCAPE '\\' "
            "          THEN 1 ELSE 0 END) ASC, rowid ASC"
        ).fetchall()
    return {
        row["email"].lower(): {
            "customer_id": (row["stripe_customer_id"]
                            if (row["stripe_customer_id"] or "").startswith("cus_") else None),
            "invite_code": row["invite_code"],
            "tier": row["tier"],
            "invited_at": row["invited_at"],
            "subscribed": bool(row["subscribed"]),
            "payment_state": row["payment_state"],
        }
        for row in rows
    }


def record_baseline_invite(path: str, *, code: str, tier: str, expires_at: str,
                           created_at: str | None = None) -> None:
    """Remember a baseline invite this system minted, so rotation may later reap it.

    Membership in this table is the sole proof of ownership: rotation deletes
    only codes recorded here, which is what makes it impossible for a member's
    checkout invite to be caught by the reaper. created_at defaults to now but
    is passed in by the rotation so it shares one clock with expires_at — the
    audit measures rotation liveness as the gap between the two.
    """
    with _conn(path) as c:
        c.execute(
            "INSERT OR REPLACE INTO baseline_invites (code, tier, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (code, tier, created_at or datetime.now(timezone.utc).isoformat(), expires_at),
        )


def all_baseline_invites(path: str) -> list[dict]:
    """Every baseline invite this system has minted, newest first."""
    with _conn(path) as c:
        rows = c.execute(
            "SELECT code, tier, created_at, expires_at FROM baseline_invites "
            "ORDER BY created_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


def forget_baseline_invite(path: str, code: str) -> None:
    """Drop a baseline invite's record once it has been deleted upstream."""
    with _conn(path) as c:
        c.execute("DELETE FROM baseline_invites WHERE code = ?", (code,))
