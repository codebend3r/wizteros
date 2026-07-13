import sqlite3

_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    wizarr_user_id     INTEGER
)
"""

_EVENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS processed_events (
    event_id TEXT PRIMARY KEY
)
"""


def _conn(path: str) -> sqlite3.Connection:
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


def init_db(path: str) -> None:
    with _conn(path) as c:
        c.execute(_SCHEMA)
        c.execute(_EVENTS_SCHEMA)


def upsert_pending(path: str, stripe_customer_id: str, email: str, invite_code: str) -> None:
    with _conn(path) as c:
        c.execute(
            """
            INSERT INTO customer_map (stripe_customer_id, email, invite_code, wizarr_user_id)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT(stripe_customer_id)
            DO UPDATE SET email = excluded.email, invite_code = excluded.invite_code
            """,
            (stripe_customer_id, email, invite_code),
        )


def set_user_id(path: str, stripe_customer_id: str, wizarr_user_id: int) -> None:
    with _conn(path) as c:
        c.execute(
            "UPDATE customer_map SET wizarr_user_id = ? WHERE stripe_customer_id = ?",
            (wizarr_user_id, stripe_customer_id),
        )


def mark_event_processed(path: str, event_id: str) -> bool:
    """Record event_id. Return True if newly recorded, False if already seen."""
    with _conn(path) as c:
        cur = c.execute(
            "INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)",
            (event_id,),
        )
        return cur.rowcount > 0


def get_mapping(path: str, stripe_customer_id: str) -> dict | None:
    with _conn(path) as c:
        row = c.execute(
            "SELECT stripe_customer_id, email, invite_code, wizarr_user_id "
            "FROM customer_map WHERE stripe_customer_id = ?",
            (stripe_customer_id,),
        ).fetchone()
    return dict(row) if row else None
