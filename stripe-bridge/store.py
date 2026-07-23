import logging
import sqlite3
from datetime import datetime, timezone

log = logging.getLogger("bridge.store")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    tier               TEXT
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


def init_db(path: str) -> None:
    """Create the tables if missing and backfill the tier column; safe every startup."""
    with _conn(path) as c:
        c.execute(_SCHEMA)
        c.execute(_EVENTS_SCHEMA)
        c.execute(_NOTES_SCHEMA)
        c.execute(_TAGS_SCHEMA)
        c.execute(_DOWNLOADS_SCHEMA)
        c.execute(_EVENT_LOG_SCHEMA)
        _ensure_tier_column(c)
        _ensure_invited_at_column(c)


_ADMIN_KEY_PREFIX = "admin:"


def upsert_pending(path: str, stripe_customer_id: str, email: str,
                   invite_code: str, tier: str | None = None) -> None:
    """Insert or update ("upsert") the customer -> email + invite code + tier mapping.

    Stamps invited_at with the current UTC time — every upsert corresponds to
    a freshly issued invite, and the stamp anchors the grace-period status.
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
            INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier, invited_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(stripe_customer_id)
            DO UPDATE SET email = excluded.email,
                          invite_code = excluded.invite_code,
                          tier = excluded.tier,
                          invited_at = excluded.invited_at
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
    """Every customer's lowercased email -> {"tier", "invited_at"} (values may be None).

    The invited_at stamp lets the admin UI age a pending invite into the
    "Declined Invite" status once the grace period lapses.
    """
    with _conn(path) as c:
        rows = c.execute(
            "SELECT email, tier, invited_at FROM customer_map WHERE email IS NOT NULL"
        ).fetchall()
    return {
        row["email"].lower(): {"tier": row["tier"], "invited_at": row["invited_at"]}
        for row in rows
    }
