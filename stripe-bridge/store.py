import sqlite3

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


def init_db(path: str) -> None:
    """Create both tables if missing and backfill the tier column; safe every startup."""
    with _conn(path) as c:
        c.execute(_SCHEMA)
        c.execute(_EVENTS_SCHEMA)
        _ensure_tier_column(c)


def upsert_pending(path: str, stripe_customer_id: str, email: str,
                   invite_code: str, tier: str | None = None) -> None:
    """Insert or update ("upsert") the customer -> email + invite code + tier mapping."""
    with _conn(path) as c:
        c.execute(
            """
            INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(stripe_customer_id)
            DO UPDATE SET email = excluded.email,
                          invite_code = excluded.invite_code,
                          tier = excluded.tier
            """,
            (stripe_customer_id, email, invite_code, tier),
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
