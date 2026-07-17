# Admin Pages (`/manage` + `/reset-user`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two password-gated admin pages to `westeroz-web` — `/manage` (paginated member table with per-row invite) and `/reset-user` (email lookup + tier/expiry presets) — served by new admin endpoints on the stripe-bridge so the Wizarr key never reaches the browser.

**Architecture:** The React SPA calls new `/admin/*` endpoints on the FastAPI bridge over Tailscale Funnel, sending a shared password in an `X-Admin-Password` header the bridge validates on every call. The bridge reuses its existing `WizarrClient` for all Wizarr work and reads tier from a new `customer_map.tier` column. The table shows one row per person (deduped across 5 servers); tier buttons disable + re-invite because Wizarr can't re-scope a member in place.

**Tech Stack:** Python 3.12 / FastAPI / pytest+responses (bridge); React 18 / TypeScript / Vite / react-router-dom v7 / vitest+testing-library (web).

Spec: `docs/superpowers/specs/2026-07-17-admin-pages-design.md`.

## Global Constraints

Every task's requirements implicitly include these.

- **TypeScript (web/src):** type aliases only, never `interface`. No `any`. **No type assertions at all** (`as` is lint-banned, `assertionStyle: 'never'`) — narrow with type guards / `unknown` instead. Import via the `@/` alias, never relative paths. Never `for..of` / `for..in` — use `map`/`filter`/`reduce`. Prefer `&&` over a ternary only when the else branch is null; guard numbers so `0` never renders. Pair `?.` with `??`. Prefer a single object parameter over positional args.
- **CSS:** SCSS modules (`*.module.scss`) per component; only use token values from `src/styles/globals.scss` (colors `--color-*`, spacing `--space-*`, radius `--radius-*`, fonts `--font-*`, sizes `--font-size-*`). Layout with grid/flex + `gap`, not margins. No class-less `div`s.
- **Python (bridge):** match existing style — small functions with one-line docstrings, list comprehensions / small loops (the JS for-loop ban does NOT apply to Python).
- **Fail-closed rule:** never share a `9X.` library. Reuse `tiers.resolve_tier_access` — never hand-roll library selection.
- **Bridge packaging:** any new `.py` module MUST be added to the Dockerfile `COPY` line.
- **Commits:** subject starts with `WZ:`; concise bullet body. Husky + lint-staged auto-runs prettier/eslint on commit.
- **Secrets:** never hardcode the Wizarr key or admin password in web code. The password lives only on the bridge (`ADMIN_PASSWORD`).

---

## Phase A — Bridge (Python)

### Task 1: Persist tier on `customer_map`

**Files:**

- Modify: `stripe-bridge/store.py`
- Test: `stripe-bridge/tests/test_store.py`

**Interfaces:**

- Produces: `store.upsert_pending(path, stripe_customer_id, email, invite_code, tier=None)`; `store.tiers_by_email(path) -> dict[str, str]` (lowercased email → tier, only rows with a tier). `store.get_mapping` shape is UNCHANGED (still 3 keys).

- [ ] **Step 1: Write the failing tests** — append to `stripe-bridge/tests/test_store.py`:

```python
def test_tier_persisted_and_looked_up_by_email(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="gold")
    store.upsert_pending(db, "cus_2", "b@x.com", "def")  # tier defaults to None

    # lookup is lowercased and only includes rows that have a tier
    assert store.tiers_by_email(db) == {"a@x.com": "gold"}
    # existing mapping shape is unchanged (no tier key)
    assert store.get_mapping(db, "cus_1") == {
        "stripe_customer_id": "cus_1", "email": "A@X.com", "invite_code": "abc",
    }


def test_init_db_adds_tier_column_to_legacy_table(tmp_path):
    import sqlite3
    db = str(tmp_path / "legacy.db")
    # simulate a pre-tier prod DB
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)")
    store.init_db(db)  # must ALTER, not crash
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="silver")
    assert store.tiers_by_email(db) == {"a@x.com": "silver"}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd stripe-bridge && python -m pytest tests/test_store.py -v`
Expected: FAIL (`tiers_by_email` missing / `upsert_pending` rejects `tier`).

- [ ] **Step 3: Implement** — edit `stripe-bridge/store.py`:

Change the schema to include `tier`:

```python
_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    tier               TEXT
)
"""
```

Add a legacy-table migration and call it from `init_db`:

```python
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
```

Widen `upsert_pending` to store the tier:

```python
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
```

Add the lookup (keep `get_mapping` exactly as-is):

```python
def tiers_by_email(path: str) -> dict[str, str]:
    """Map lowercased email -> tier for every mapping that has a tier recorded."""
    with _conn(path) as c:
        rows = c.execute(
            "SELECT email, tier FROM customer_map WHERE tier IS NOT NULL AND email IS NOT NULL"
        ).fetchall()
    return {row["email"].lower(): row["tier"] for row in rows}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/test_store.py -v`
Expected: PASS (all, including the two existing tests).

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/store.py stripe-bridge/tests/test_store.py
git commit -m "WZ: Persist member tier on customer_map"
```

---

### Task 2: Write tier at checkout

**Files:**

- Modify: `stripe-bridge/stripe_wizarr_bridge.py` (checkout handler in `_dispatch`, ~line 141)
- Test: `stripe-bridge/tests/test_bridge.py`

**Interfaces:**

- Consumes: `store.upsert_pending(..., tier=)`, `store.tiers_by_email` (Task 1).

- [ ] **Step 1: Write the failing test** — append to `stripe-bridge/tests/test_bridge.py`:

```python
def test_checkout_records_tier_for_the_customer(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_tier_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    import store
    assert store.tiers_by_email(bridge.MAP_DB_PATH) == {"a@x.com": "gold"}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_bridge.py::test_checkout_records_tier_for_the_customer -v`
Expected: FAIL (`tiers_by_email` returns `{}` — tier not written).

- [ ] **Step 3: Implement** — in `stripe_wizarr_bridge.py`, find in the `checkout.session.completed` branch:

```python
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, invite["code"])
```

Replace with:

```python
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, invite["code"], tier=tier)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/test_bridge.py -v`
Expected: PASS (new test + all existing bridge tests).

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/stripe_wizarr_bridge.py stripe-bridge/tests/test_bridge.py
git commit -m "WZ: Record tier at checkout for the admin table"
```

---

### Task 3: `WizarrClient.list_users()`

**Files:**

- Modify: `stripe-bridge/wizarr.py`
- Test: `stripe-bridge/tests/test_wizarr.py`

**Interfaces:**

- Produces: `WizarrClient.list_users() -> list` (every record, one per person per server).

- [ ] **Step 1: Write the failing test** — append to `stripe-bridge/tests/test_wizarr.py`:

```python
@responses.activate
def test_list_users_returns_all_records():
    responses.get(f"{BASE}/api/users", json={"users": [
        {"id": 9, "username": "cj", "email": "a@x.com", "server": "Meleys", "expires": None},
        {"id": 12, "username": "cj", "email": "a@x.com", "server": "Vhagar", "expires": None},
    ]})
    out = client().list_users()
    assert [u["id"] for u in out] == [9, 12]
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_wizarr.py::test_list_users_returns_all_records -v`
Expected: FAIL (`AttributeError: 'WizarrClient' object has no attribute 'list_users'`).

- [ ] **Step 3: Implement** — in `stripe-bridge/wizarr.py`, add right after `_users`:

```python
    def list_users(self) -> list:
        """Every user record Wizarr knows (one per person per server)."""
        return self._users({})
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/test_wizarr.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/wizarr.py stripe-bridge/tests/test_wizarr.py
git commit -m "WZ: Add WizarrClient.list_users for the admin table"
```

---

### Task 4: Admin module — auth + member read endpoints

**Files:**

- Create: `stripe-bridge/admin.py`
- Test: `stripe-bridge/tests/test_admin.py`

**Interfaces:**

- Consumes: `store.tiers_by_email`, `WizarrClient.list_users`, `tiers.TIER_DOWNLOADS`.
- Produces (used by Task 5 & the web): module globals `router` (APIRouter), `client` (WizarrClient), `MAP_DB_PATH`, `ADMIN_PASSWORD`; `require_admin(x_admin_password)`; `list_members() -> list[dict]`; `get_member(email) -> dict`; helper `_dedupe_members(users, tier_map) -> list[dict]`.
- `Member` dict keys: `member, email, tier, downloads, expires, servers, subscribed`.

- [ ] **Step 1: Write the failing tests** — create `stripe-bridge/tests/test_admin.py`:

```python
import importlib
import os
from unittest.mock import MagicMock

import pytest

# Env required before importing the module (mirrors test_bridge).
os.environ.update({
    "ADMIN_PASSWORD": "secret",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "INVITE_EXPIRES_DAYS": "7", "ACCESS_DURATION": "35",
    "PUBLIC_INVITE_BASE": "http://inv.test",
})

import admin  # noqa: E402
import store  # noqa: E402
from fastapi import HTTPException  # noqa: E402

USERS = [
    {"id": 1, "username": "cj", "email": "A@X.com", "server": "Meleys", "expires": "2026-09-01T00:00:00+00:00"},
    {"id": 2, "username": "cj", "email": "a@x.com", "server": "Vhagar", "expires": "2026-09-10T00:00:00+00:00"},
    {"id": 3, "username": "nora", "email": "nora@x.com", "server": "Syrax", "expires": None},
]


@pytest.fixture
def admin_db(tmp_path, monkeypatch):
    importlib.reload(admin)
    dbp = str(tmp_path / "bridge.db")
    store.init_db(dbp)
    monkeypatch.setattr(admin, "MAP_DB_PATH", dbp)
    admin.client = MagicMock()
    admin.client.list_users.return_value = USERS
    return admin, dbp


def test_require_admin_rejects_wrong_or_missing_password(admin_db):
    a, _ = admin_db
    with pytest.raises(HTTPException) as bad:
        a.require_admin("nope")
    assert bad.value.status_code == 401
    with pytest.raises(HTTPException):
        a.require_admin("")
    assert a.require_admin("secret") is None  # correct password passes


def test_list_members_dedupes_and_joins_tier(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    members = a.list_members()
    by_email = {m["email"].lower(): m for m in members}

    cj = by_email["a@x.com"]
    assert cj["member"] == "cj"
    assert sorted(cj["servers"]) == ["Meleys", "Vhagar"]  # 2 records -> 1 person
    assert cj["expires"] == "2026-09-10T00:00:00+00:00"   # latest wins
    assert cj["subscribed"] is True
    assert cj["tier"] == "gold"
    assert cj["downloads"] is True                         # derived from tier

    nora = by_email["nora@x.com"]
    assert nora["subscribed"] is False
    assert nora["tier"] == "unknown"
    assert nora["downloads"] is None


def test_get_member_found_and_missing(admin_db):
    a, dbp = admin_db
    found = a.get_member("a@x.com")
    assert found["member"] == "cj"
    with pytest.raises(HTTPException) as missing:
        a.get_member("ghost@x.com")
    assert missing.value.status_code == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_admin.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'admin'`).

- [ ] **Step 3: Implement** — create `stripe-bridge/admin.py`:

```python
import os

from fastapi import APIRouter, Depends, Header, HTTPException

import store
import tiers
from wizarr import WizarrClient

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
router = APIRouter()


def require_admin(x_admin_password: str = Header(default="")) -> None:
    """Reject any admin request whose header doesn't match ADMIN_PASSWORD.

    Fails closed: an unset ADMIN_PASSWORD rejects everything.
    """
    if not ADMIN_PASSWORD or x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="unauthorized")


def _dedupe_members(users: list, tier_map: dict) -> list[dict]:
    """Collapse per-server Wizarr records into one entry per person.

    Key is the lowercased email (falling back to username). Aggregates the
    servers a person appears on and keeps the latest expiry across records.
    Tier is joined from the bridge's store; downloads derive from tier.
    """
    people: dict[str, dict] = {}
    for u in users:
        email = (u.get("email") or "").strip()
        username = u.get("username") or ""
        key = (email or username).lower()
        if not key:
            continue
        person = people.setdefault(key, {
            "member": username, "email": email, "servers": [], "expires": None,
        })
        server = u.get("server")
        if server and server not in person["servers"]:
            person["servers"].append(server)
        exp = u.get("expires")
        if exp and (person["expires"] is None or exp > person["expires"]):
            person["expires"] = exp

    members = []
    for person in people.values():
        tier = (tier_map.get(person["email"].lower()) if person["email"] else None) or "unknown"
        downloads = tiers.TIER_DOWNLOADS.get(tier) if tier != "unknown" else None
        members.append({
            "member": person["member"],
            "email": person["email"],
            "tier": tier,
            "downloads": downloads,
            "expires": person["expires"],
            "servers": sorted(person["servers"]),
            "subscribed": person["expires"] is not None,
        })
    members.sort(key=lambda m: m["member"].lower())
    return members


@router.get("/admin/members", dependencies=[Depends(require_admin)])
def list_members() -> list[dict]:
    """One row per person across all servers, with tier + derived downloads."""
    return _dedupe_members(client.list_users(), store.tiers_by_email(MAP_DB_PATH))


@router.get("/admin/member", dependencies=[Depends(require_admin)])
def get_member(email: str) -> dict:
    """The single deduped member matching an email, or 404."""
    matches = _dedupe_members(
        [u for u in client.list_users() if (u.get("email") or "").lower() == email.lower()],
        store.tiers_by_email(MAP_DB_PATH),
    )
    if not matches:
        raise HTTPException(status_code=404, detail="no member for that email")
    return matches[0]
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/test_admin.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/admin.py stripe-bridge/tests/test_admin.py
git commit -m "WZ: Add admin auth + member read endpoints to the bridge"
```

---

### Task 5: Admin module — reset-expiry + reissue-invite

**Files:**

- Modify: `stripe-bridge/admin.py`, `stripe-bridge/wizarr.py` (widen `set_expiry` type)
- Test: `stripe-bridge/tests/test_admin.py`

**Interfaces:**

- Consumes: `client.find_user_ids_by_email`, `client.set_expiry`, `client.disable_user`, `client.list_libraries`, `client.create_invite`, `tiers.resolve_tier_access`, `tiers.normalize_tier`.
- Produces: `POST /admin/reset-expiry` (`ResetExpiryBody{email, days}`) → `{updated, expires}`; `POST /admin/reissue-invite` (`ReissueInviteBody{email, tier}`) → `{url, code, tier, disabled}`.

- [ ] **Step 1: Write the failing tests** — append to `stripe-bridge/tests/test_admin.py`:

```python
FIXTURE_LIBRARIES = [
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
]


def test_reset_expiry_sets_absolute_date_on_every_record(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = [9, 12]
    out = a.reset_expiry(a.ResetExpiryBody(email="a@x.com", days=15))
    assert out["updated"] == 2
    assert out["expires"] is not None
    assert a.client.set_expiry.call_count == 2


def test_reset_expiry_clears_with_null_days(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = [9]
    out = a.reset_expiry(a.ResetExpiryBody(email="a@x.com", days=None))
    assert out == {"updated": 1, "expires": None}
    a.client.set_expiry.assert_called_once_with(9, None)


def test_reset_expiry_404_when_no_records(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = []
    with pytest.raises(HTTPException) as e:
        a.reset_expiry(a.ResetExpiryBody(email="ghost@x.com", days=15))
    assert e.value.status_code == 404


def test_reissue_invite_disables_then_creates_scoped_invite(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_user_ids_by_email.return_value = [9, 12]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))

    assert a.client.disable_user.call_count == 2  # both existing records dropped
    # private 99. library excluded, non-4k allowed for silver -> ids 17 + 20
    a.client.create_invite.assert_called_once_with(
        [1], 7, "35", library_ids=[17, 20], allow_downloads=False)
    assert out["disabled"] == 2
    assert out["code"] == "xyz"
    assert out["url"] == "http://inv.test/j/xyz"  # public URL, not the LAN one
    assert out["tier"] == "silver"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd stripe-bridge && python -m pytest tests/test_admin.py -k "reset_expiry or reissue" -v`
Expected: FAIL (`AttributeError` — `reset_expiry` / `reissue_invite` / body models missing).

- [ ] **Step 3: Implement**

First widen `WizarrClient.set_expiry` in `stripe-bridge/wizarr.py` to accept a clear:

```python
    def set_expiry(self, user_id: int, expires_iso: str | None) -> None:
        """Set a record's expiry to an absolute ISO datetime, or None to clear it."""
        r = requests.put(
            f"{self.base_url}/api/users/{user_id}/update-expiry",
            headers=self._headers(),
            json={"expires": expires_iso},
            timeout=10,
        )
        r.raise_for_status()
```

Then add to `stripe-bridge/admin.py` — extend the imports at the top:

```python
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

import store
import tiers
from wizarr import WizarrClient
```

Add config constants alongside the existing ones:

```python
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "7"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")
PUBLIC_INVITE_BASE = os.environ.get("PUBLIC_INVITE_BASE", "").rstrip("/")
```

Add the body models and endpoints at the end of the file:

```python
class ResetExpiryBody(BaseModel):
    email: str
    days: int | None


class ReissueInviteBody(BaseModel):
    email: str
    tier: str


@router.post("/admin/reset-expiry", dependencies=[Depends(require_admin)])
def reset_expiry(body: ResetExpiryBody) -> dict:
    """Set (or clear, days=None) the expiry on every record for an email. In-place."""
    ids = client.find_user_ids_by_email(body.email)
    if not ids:
        raise HTTPException(status_code=404, detail="no member for that email")
    expires = None
    if body.days is not None:
        expires = (datetime.now(timezone.utc) + timedelta(days=body.days)).isoformat()
    for uid in ids:
        client.set_expiry(uid, expires)
    return {"updated": len(ids), "expires": expires}


@router.post("/admin/reissue-invite", dependencies=[Depends(require_admin)])
def reissue_invite(body: ReissueInviteBody) -> dict:
    """Disable a member's records, then issue a fresh tier-scoped invite link.

    Wizarr can't re-scope a member in place, so we drop every existing record
    and re-invite. Scope comes from tiers.resolve_tier_access (fail-closed on
    9X. privates). Returns the public re-join URL.
    """
    tier = tiers.normalize_tier(body.tier)
    access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
    if not access["library_ids"]:
        raise HTTPException(status_code=502, detail=f"no libraries resolved for tier {tier}")
    ids = client.find_user_ids_by_email(body.email)
    for uid in ids:
        client.disable_user(uid)
    invite = client.create_invite(
        access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
        library_ids=access["library_ids"], allow_downloads=access["allow_downloads"],
    )
    return {
        "url": f"{PUBLIC_INVITE_BASE}/j/{invite['code']}",
        "code": invite["code"],
        "tier": tier,
        "disabled": len(ids),
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/test_admin.py -v`
Expected: PASS (all admin tests).

- [ ] **Step 5: VERIFY THE NULL-EXPIRY CLEAR AGAINST LIVE WIZARR (operator-run, do not skip)**

The "No expiry" preset assumes `PUT /api/users/{id}/update-expiry` accepts `{"expires": null}`. This has NOT been proven and must be checked before relying on it — pick a **known throwaway/test record id** with the operator's OK (never a random member):

```bash
# Read the id + confirm it's safe to touch, then:
curl -s -X PUT "http://192.168.50.2:5690/api/users/<TEST_ID>/update-expiry" \
  -H "X-API-Key: $WIZARR_API_KEY" -H "Content-Type: application/json" \
  -d '{"expires": null}' -w "\nHTTP %{http_code}\n"
```

- If it returns 2xx and clears the expiry → the implementation above is correct; done.
- If it 4xx/5xxs → Wizarr won't clear via null. Fall back: in `reset_expiry`, for `days is None` set a far-future date instead (`timedelta(days=3650)`), rename the preset to "Effectively no expiry" in Task 11, and update `test_reset_expiry_clears_with_null_days` to expect that date. Note the outcome in the commit body.

- [ ] **Step 6: Commit**

```bash
git add stripe-bridge/admin.py stripe-bridge/wizarr.py stripe-bridge/tests/test_admin.py
git commit -m "WZ: Add admin reset-expiry + reissue-invite endpoints"
```

---

### Task 6: Mount the admin router + config

**Files:**

- Modify: `stripe-bridge/stripe_wizarr_bridge.py`, `stripe-bridge/Dockerfile`, `.env.example`
- Test: `stripe-bridge/tests/test_admin.py`

**Interfaces:**

- Consumes: `admin.router` (Task 4/5).
- Produces: `/admin/*` and `/stripe/admin/*` routes on the bridge app; CORS for the SPA origin.

- [ ] **Step 1: Write the failing test** — append to `stripe-bridge/tests/test_admin.py`:

```python
def test_bridge_app_mounts_admin_routes_bare_and_prefixed():
    os.environ.update({
        "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
        "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
        "SMTP_PASS": "p", "FROM_ADDR": "server@test",
        "MAP_DB_PATH": "/tmp/mount-test.db",
    })
    import stripe_wizarr_bridge as b
    importlib.reload(b)
    paths = {r.path for r in b.app.routes}
    assert "/admin/members" in paths
    assert "/stripe/admin/members" in paths
    assert "/admin/reissue-invite" in paths
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_admin.py::test_bridge_app_mounts_admin_routes_bare_and_prefixed -v`
Expected: FAIL (admin routes not on the app).

- [ ] **Step 3: Implement** — in `stripe-bridge/stripe_wizarr_bridge.py`:

Add imports near the top (after `from fastapi import ...`):

```python
from fastapi.middleware.cors import CORSMiddleware

import admin
```

After `app = FastAPI()` add:

```python
ADMIN_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ADMIN_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ADMIN_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["X-Admin-Password", "Content-Type"],
)
# Bare paths serve Funnel-proxied calls (the /stripe prefix is stripped by
# Funnel); the /stripe-prefixed copy serves direct/local calls, mirroring the
# dual /webhook + /stripe/webhook handlers below.
app.include_router(admin.router)
app.include_router(admin.router, prefix="/stripe")
```

Add `admin.py` to the Dockerfile `COPY` line in `stripe-bridge/Dockerfile`:

```dockerfile
COPY store.py wizarr.py tiers.py stripe_wizarr_bridge.py email_template.py admin.py .
```

Add the new vars to `.env.example` (root), under the Wizarr block:

```bash
# Admin pages (/manage, /reset-user) — the shared password the bridge checks on
# every /admin/* request, and the browser origins allowed to call it (CORS).
ADMIN_PASSWORD=morty8229!
ADMIN_ALLOWED_ORIGINS=http://localhost:5173,https://<your-netlify-site>.netlify.app
```

- [ ] **Step 4: Run to verify pass**

Run: `cd stripe-bridge && python -m pytest tests/ -v`
Expected: PASS (entire bridge suite).

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/stripe_wizarr_bridge.py stripe-bridge/Dockerfile .env.example
git commit -m "WZ: Mount admin router with CORS on the bridge"
```

---

## Phase B — Web (React)

### Task 7: `lib/adminApi.ts` — typed client + guards

**Files:**

- Create: `web/src/lib/adminApi.ts`
- Test: `web/src/lib/adminApi.test.ts`

**Interfaces:**

- Produces: types `PaidTier`, `Tier`, `Member`, `InviteResult`, `ResetExpiryResult`; class `AdminAuthError`; `fetchMembers({password})`, `fetchMember({email, password})` (→ `Member | null`), `resetExpiry({email, days, password})`, `reissueInvite({email, tier, password})`.

- [ ] **Step 1: Write the failing tests** — create `web/src/lib/adminApi.test.ts`:

```ts
import { afterEach, expect, test, vi } from 'vitest'
import { AdminAuthError, fetchMember, fetchMembers, reissueInvite } from '@/lib/adminApi'

const member = {
  member: 'cj',
  email: 'a@x.com',
  tier: 'gold',
  downloads: true,
  expires: '2026-09-01T00:00:00+00:00',
  servers: ['Meleys'],
  subscribed: true,
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('fetchMembers sends the password header and returns validated members', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [member] })
  vi.stubGlobal('fetch', fetchMock)

  const result = await fetchMembers({ password: 'secret' })

  expect(result).toEqual([member])
  const [, init] = fetchMock.mock.calls[0]
  expect(init.headers['X-Admin-Password']).toBe('secret')
})

test('fetchMembers throws AdminAuthError on 401', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
  )
  await expect(fetchMembers({ password: 'wrong' })).rejects.toBeInstanceOf(AdminAuthError)
})

test('fetchMember returns null on 404', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
  )
  await expect(fetchMember({ email: 'ghost@x.com', password: 'secret' })).resolves.toBeNull()
})

test('reissueInvite posts email + tier and returns the invite link', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ url: 'http://inv/j/xyz', code: 'xyz', tier: 'bronze', disabled: 1 }),
  })
  vi.stubGlobal('fetch', fetchMock)

  const result = await reissueInvite({ email: 'a@x.com', tier: 'bronze', password: 'secret' })

  expect(result.url).toBe('http://inv/j/xyz')
  const [, init] = fetchMock.mock.calls[0]
  expect(JSON.parse(init.body)).toEqual({ email: 'a@x.com', tier: 'bronze' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/lib/adminApi.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `web/src/lib/adminApi.ts`:

```ts
export type PaidTier = 'bronze' | 'silver' | 'gold' | 'kids'
export type Tier = PaidTier | 'unknown'

export type Member = {
  member: string
  email: string
  tier: Tier
  downloads: boolean | null
  expires: string | null
  servers: string[]
  subscribed: boolean
}

export type InviteResult = {
  url: string
  code: string
  tier: string
  disabled: number
}

export type ResetExpiryResult = {
  updated: number
  expires: string | null
}

export class AdminAuthError extends Error {}

const ADMIN_API_BASE: string = import.meta.env.VITE_ADMIN_API_BASE ?? ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'kids', 'unknown']

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

const isMember = (value: unknown): value is Member =>
  isRecord(value) &&
  typeof value.member === 'string' &&
  typeof value.email === 'string' &&
  isTier(value.tier) &&
  (typeof value.downloads === 'boolean' || value.downloads === null) &&
  (typeof value.expires === 'string' || value.expires === null) &&
  isStringArray(value.servers) &&
  typeof value.subscribed === 'boolean'

const isMemberArray = (value: unknown): value is Member[] =>
  Array.isArray(value) && value.every(isMember)

const isInviteResult = (value: unknown): value is InviteResult =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  typeof value.code === 'string' &&
  typeof value.tier === 'string' &&
  typeof value.disabled === 'number'

const isResetExpiryResult = (value: unknown): value is ResetExpiryResult =>
  isRecord(value) &&
  typeof value.updated === 'number' &&
  (typeof value.expires === 'string' || value.expires === null)

type RequestArgs = {
  path: string
  password: string
  method?: 'GET' | 'POST'
  body?: unknown
}

const requestJson = async ({
  path,
  password,
  method = 'GET',
  body,
}: RequestArgs): Promise<unknown> => {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    method,
    headers: {
      'X-Admin-Password': password,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    throw new AdminAuthError('Wrong password')
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  return response.json()
}

export const fetchMembers = async ({ password }: { password: string }): Promise<Member[]> => {
  const data = await requestJson({ path: '/admin/members', password })
  if (!isMemberArray(data)) {
    throw new Error('Unexpected members response')
  }
  return data
}

export const fetchMember = async ({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<Member | null> => {
  const response = await fetch(
    `${ADMIN_API_BASE}/admin/member?email=${encodeURIComponent(email)}`,
    {
      headers: { 'X-Admin-Password': password },
    },
  )
  if (response.status === 401) {
    throw new AdminAuthError('Wrong password')
  }
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  const data: unknown = await response.json()
  if (!isMember(data)) {
    throw new Error('Unexpected member response')
  }
  return data
}

export const resetExpiry = async ({
  email,
  days,
  password,
}: {
  email: string
  days: number | null
  password: string
}): Promise<ResetExpiryResult> => {
  const data = await requestJson({
    path: '/admin/reset-expiry',
    password,
    method: 'POST',
    body: { email, days },
  })
  if (!isResetExpiryResult(data)) {
    throw new Error('Unexpected reset-expiry response')
  }
  return data
}

export const reissueInvite = async ({
  email,
  tier,
  password,
}: {
  email: string
  tier: PaidTier
  password: string
}): Promise<InviteResult> => {
  const data = await requestJson({
    path: '/admin/reissue-invite',
    password,
    method: 'POST',
    body: { email, tier },
  })
  if (!isInviteResult(data)) {
    throw new Error('Unexpected reissue-invite response')
  }
  return data
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/lib/adminApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/adminApi.ts web/src/lib/adminApi.test.ts
git commit -m "WZ: Add typed admin API client for the web pages"
```

---

### Task 8: `AdminGate` — shared password gate

**Files:**

- Create: `web/src/components/AdminGate/AdminGate.tsx`, `web/src/components/AdminGate/AdminGate.module.scss`
- Test: `web/src/components/AdminGate/AdminGate.test.tsx`

**Interfaces:**

- Produces: default export `AdminGate` (`{title, children}`); named export `useAdminAuth() -> {password, deauthenticate}`.

- [ ] **Step 1: Write the failing test** — create `web/src/components/AdminGate/AdminGate.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test } from 'vitest'
import AdminGate from '@/components/AdminGate/AdminGate'

afterEach(() => {
  sessionStorage.clear()
})

test('hides children until a password is entered', async () => {
  render(
    <AdminGate title="Test gate">
      <p>secret content</p>
    </AdminGate>,
  )
  expect(screen.queryByText('secret content')).toBeNull()

  await userEvent.type(screen.getByLabelText('Password'), 'morty8229!')
  await userEvent.click(screen.getByRole('button', { name: 'Enter' }))

  expect(screen.getByText('secret content')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/components/AdminGate/AdminGate.test.tsx`
Expected: FAIL (module not found). (If `@testing-library/user-event` is absent, `npm i -D @testing-library/user-event` first.)

- [ ] **Step 3: Implement** — create `web/src/components/AdminGate/AdminGate.tsx`:

```tsx
import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react'
import styles from '@/components/AdminGate/AdminGate.module.scss'

type AdminAuth = {
  password: string
  deauthenticate: () => void
}

const AdminAuthContext = createContext<AdminAuth | null>(null)

export const useAdminAuth = (): AdminAuth => {
  const auth = useContext(AdminAuthContext)
  if (!auth) {
    throw new Error('useAdminAuth must be used within AdminGate')
  }
  return auth
}

const STORAGE_KEY = 'westeroz-admin-password'

type AdminGateProps = {
  title: string
  children: ReactNode
}

const AdminGate = ({ title, children }: AdminGateProps) => {
  const [password, setPassword] = useState<string>(() => sessionStorage.getItem(STORAGE_KEY) ?? '')
  const [draft, setDraft] = useState('')

  const authenticate = (event: FormEvent) => {
    event.preventDefault()
    sessionStorage.setItem(STORAGE_KEY, draft)
    setPassword(draft)
  }

  const deauthenticate = () => {
    sessionStorage.removeItem(STORAGE_KEY)
    setPassword('')
    setDraft('')
  }

  if (!password) {
    return (
      <main className={styles.gate}>
        <form className={styles.form} onSubmit={authenticate}>
          <h1 className={styles.title}>{title}</h1>
          <label className={styles.label} htmlFor="admin-password">
            Password
          </label>
          <input
            id="admin-password"
            className={styles.input}
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className={styles.button} type="submit">
            Enter
          </button>
        </form>
      </main>
    )
  }

  return (
    <AdminAuthContext.Provider value={{ password, deauthenticate }}>
      {children}
    </AdminAuthContext.Provider>
  )
}

export default AdminGate
```

Create `web/src/components/AdminGate/AdminGate.module.scss`:

```scss
.gate {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--space-3);
}

.form {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  max-width: 22rem;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.title {
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  font-weight: 700;
}

.label {
  font-size: var(--font-size-sm);
  color: var(--color-muted);
}

.input {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
}

.button {
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-weight: 600;
  cursor: pointer;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/AdminGate/AdminGate.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AdminGate/
git commit -m "WZ: Add shared AdminGate password wrapper"
```

---

### Task 9: `MembersTable` — presentational table + client pagination

**Files:**

- Create: `web/src/components/MembersTable/MembersTable.tsx`, `web/src/components/MembersTable/MembersTable.module.scss`
- Test: `web/src/components/MembersTable/MembersTable.test.tsx`

**Interfaces:**

- Consumes: `Member` (Task 7).
- Produces: default export `MembersTable` (`{members, onInvite, invitingEmail}`). Page size 25.

- [ ] **Step 1: Write the failing tests** — create `web/src/components/MembersTable/MembersTable.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import MembersTable from '@/components/MembersTable/MembersTable'
import type { Member } from '@/lib/adminApi'

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  subscribed: false,
  ...overrides,
})

test('shows Subscribed for members with an expiry and an Invite button otherwise', () => {
  render(
    <MembersTable
      members={[
        makeMember({ email: 'sub@x.com', subscribed: true }),
        makeMember({ email: 'free@x.com', subscribed: false }),
      ]}
      onInvite={vi.fn()}
      invitingEmail={null}
    />,
  )
  expect(screen.getByText('Subscribed')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(1)
})

test('paginates at 25 rows per page', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(<MembersTable members={members} onInvite={vi.fn()} invitingEmail={null} />)

  expect(screen.getByText('u0')).toBeInTheDocument()
  expect(screen.queryByText('u25')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('u25')).toBeInTheDocument()
})

test('calls onInvite with the member when Invite is clicked', async () => {
  const onInvite = vi.fn()
  const target = makeMember({ email: 'free@x.com', subscribed: false })
  render(<MembersTable members={[target]} onInvite={onInvite} invitingEmail={null} />)
  await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
  expect(onInvite).toHaveBeenCalledWith(target)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/components/MembersTable/MembersTable.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `web/src/components/MembersTable/MembersTable.tsx`:

```tsx
import { useState } from 'react'
import type { Member } from '@/lib/adminApi'
import styles from '@/components/MembersTable/MembersTable.module.scss'

const PAGE_SIZE = 25

type MembersTableProps = {
  members: ReadonlyArray<Member>
  onInvite: (member: Member) => void
  invitingEmail: string | null
}

const formatExpiry = (expires: string | null): string => {
  if (!expires) {
    return '—'
  }
  const date = new Date(expires)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

const formatDownloads = (downloads: boolean | null): string => {
  if (downloads === null) {
    return '—'
  }
  return downloads ? '✓' : '✗'
}

const MembersTable = ({ members, onInvite, invitingEmail }: MembersTableProps) => {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(members.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const start = current * PAGE_SIZE
  const visible = members.slice(start, start + PAGE_SIZE)

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Email</th>
            <th>Tier</th>
            <th>Downloads</th>
            <th>Expiry</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((member) => (
            <tr key={`${member.email}-${member.member}`}>
              <td>{member.member}</td>
              <td>{member.email}</td>
              <td className={styles.tier}>{member.tier}</td>
              <td>{formatDownloads(member.downloads)}</td>
              <td>{formatExpiry(member.expires)}</td>
              <td>
                {member.subscribed ? (
                  <span className={styles.subscribed}>Subscribed</span>
                ) : (
                  <button
                    className={styles.invite}
                    type="button"
                    onClick={() => onInvite(member)}
                    disabled={invitingEmail === member.email}
                  >
                    {invitingEmail === member.email ? 'Inviting…' : 'Invite'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.pager}>
        <button type="button" onClick={() => setPage(current - 1)} disabled={current === 0}>
          Prev
        </button>
        <span className={styles.count}>
          Page {current + 1} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => setPage(current + 1)}
          disabled={current >= pageCount - 1}
        >
          Next
        </button>
      </div>
    </div>
  )
}

export default MembersTable
```

Create `web/src/components/MembersTable/MembersTable.module.scss`:

```scss
.wrap {
  display: grid;
  gap: var(--space-2);
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);

  th,
  td {
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--color-border);
    text-align: left;
  }

  th {
    color: var(--color-muted);
    font-size: var(--font-size-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
}

.tier {
  text-transform: capitalize;
}

.subscribed {
  color: var(--color-accent);
  font-weight: 600;
}

.invite {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}

.pager {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  button {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--color-text);
    cursor: pointer;

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }
}

.count {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/MembersTable/MembersTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MembersTable/
git commit -m "WZ: Add paginated MembersTable"
```

---

### Task 10: `/manage` page

**Files:**

- Create: `web/src/pages/Manage/Manage.tsx`, `web/src/pages/Manage/Manage.module.scss`
- Test: `web/src/pages/Manage/Manage.test.tsx`

**Interfaces:**

- Consumes: `AdminGate`/`useAdminAuth` (Task 8), `MembersTable` (Task 9), `fetchMembers`/`reissueInvite`/`AdminAuthError` (Task 7).
- Produces: default export `Manage`.

- [ ] **Step 1: Write the failing test** — create `web/src/pages/Manage/Manage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Manage from '@/pages/Manage/Manage'
import type { Member } from '@/lib/adminApi'

const member: Member = {
  member: 'cj',
  email: 'cj@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Meleys'],
  subscribed: false,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMembers: vi.fn(),
}))

const { fetchMembers } = await import('@/lib/adminApi')

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('loads and renders members after the gate', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  render(<Manage />)
  expect(await screen.findByText('cj')).toBeInTheDocument()
  expect(fetchMembers).toHaveBeenCalledWith({ password: 'secret' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/pages/Manage/Manage.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `web/src/pages/Manage/Manage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import MembersTable from '@/components/MembersTable/MembersTable'
import { AdminAuthError, fetchMembers, reissueInvite, type Member } from '@/lib/adminApi'
import styles from '@/pages/Manage/Manage.module.scss'

const ManageInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invitingEmail, setInvitingEmail] = useState<string | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setError(null)
    fetchMembers({ password })
      .then((result) => {
        if (active) {
          setMembers(result)
        }
      })
      .catch((cause) => {
        if (!active) {
          return
        }
        if (cause instanceof AdminAuthError) {
          deauthenticate()
          return
        }
        setError('Could not load members.')
      })
    return () => {
      active = false
    }
  }, [password])

  const invite = (member: Member) => {
    setInvitingEmail(member.email)
    setInviteLink(null)
    setError(null)
    reissueInvite({ email: member.email, tier: 'bronze', password })
      .then((result) => setInviteLink(result.url))
      .catch((cause) => {
        if (cause instanceof AdminAuthError) {
          deauthenticate()
          return
        }
        setError('Could not create invite.')
      })
      .finally(() => setInvitingEmail(null))
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Members</h1>
      {!!error && <p className={styles.error}>{error}</p>}
      {!!inviteLink && (
        <p className={styles.invite}>
          Invite link: <a href={inviteLink}>{inviteLink}</a>
        </p>
      )}
      {members === null && !error && (
        <p className={styles.loading}>Loading members… (this can take ~15s)</p>
      )}
      {!!members && (
        <MembersTable members={members} onInvite={invite} invitingEmail={invitingEmail} />
      )}
    </main>
  )
}

const Manage = () => (
  <AdminGate title="Westeroz — Manage">
    <ManageInner />
  </AdminGate>
)

export default Manage
```

Create `web/src/pages/Manage/Manage.module.scss`:

```scss
.page {
  display: grid;
  gap: var(--space-3);
  max-width: var(--max-width);
  margin-inline: auto;
  padding: var(--space-4) var(--space-3);
}

.title {
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
  font-weight: 700;
}

.loading {
  color: var(--color-muted);
}

.error {
  color: var(--color-kids);
}

.invite {
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  word-break: break-all;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/pages/Manage/Manage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Manage/
git commit -m "WZ: Add /manage members page"
```

---

### Task 11: `/reset-user` page

**Files:**

- Create: `web/src/pages/ResetUser/ResetUser.tsx`, `web/src/pages/ResetUser/ResetUser.module.scss`
- Test: `web/src/pages/ResetUser/ResetUser.test.tsx`

**Interfaces:**

- Consumes: `AdminGate`/`useAdminAuth` (Task 8), `fetchMember`/`resetExpiry`/`reissueInvite`/`AdminAuthError` (Task 7).
- Produces: default export `ResetUser`.

> If Task 5 Step 5 found that null-clear is unsupported, rename the first expiry preset label to "Effectively no expiry" (its `days` value stays what Task 5 chose) — the button wiring is unchanged.

- [ ] **Step 1: Write the failing tests** — create `web/src/pages/ResetUser/ResetUser.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ResetUser from '@/pages/ResetUser/ResetUser'
import type { Member } from '@/lib/adminApi'

const member: Member = {
  member: 'cj',
  email: 'cj@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Meleys'],
  subscribed: false,
}

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMember: vi.fn(),
  resetExpiry: vi.fn(),
  reissueInvite: vi.fn(),
}))

const api = await import('@/lib/adminApi')

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('disables Find until the input is a valid email', async () => {
  render(<ResetUser />)
  const find = screen.getByRole('button', { name: 'Find' })
  expect(find).toBeDisabled()
  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  expect(find).toBeEnabled()
})

test('looks up a member and applies an expiry preset', async () => {
  vi.mocked(api.fetchMember).mockResolvedValue(member)
  vi.mocked(api.resetExpiry).mockResolvedValue({ updated: 1, expires: null })
  render(<ResetUser />)

  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  await userEvent.click(screen.getByRole('button', { name: 'Find' }))

  await userEvent.click(await screen.findByRole('button', { name: '35 days' }))
  expect(api.resetExpiry).toHaveBeenCalledWith({ email: 'cj@x.com', days: 35, password: 'secret' })
})

test('applies a tier preset via reissue-invite', async () => {
  vi.mocked(api.fetchMember).mockResolvedValue(member)
  vi.mocked(api.reissueInvite).mockResolvedValue({
    url: 'http://inv/j/x',
    code: 'x',
    tier: 'silver',
    disabled: 1,
  })
  render(<ResetUser />)

  await userEvent.type(screen.getByPlaceholderText('member@email.com'), 'cj@x.com')
  await userEvent.click(screen.getByRole('button', { name: 'Find' }))
  await userEvent.click(await screen.findByRole('button', { name: 'silver' }))
  expect(api.reissueInvite).toHaveBeenCalledWith({
    email: 'cj@x.com',
    tier: 'silver',
    password: 'secret',
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/pages/ResetUser/ResetUser.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — create `web/src/pages/ResetUser/ResetUser.tsx`:

```tsx
import { useState, type FormEvent } from 'react'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import {
  AdminAuthError,
  fetchMember,
  reissueInvite,
  resetExpiry,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import styles from '@/pages/ResetUser/ResetUser.module.scss'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TIERS: ReadonlyArray<PaidTier> = ['bronze', 'silver', 'gold', 'kids']
const EXPIRY_PRESETS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'No expiry', days: null },
  { label: '15 days', days: 15 },
  { label: '35 days', days: 35 },
  { label: '70 days', days: 70 },
]

const ResetUserInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const [email, setEmail] = useState('')
  const [member, setMember] = useState<Member | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const valid = EMAIL_RE.test(email)

  const onAuthError = (cause: unknown): boolean => {
    if (cause instanceof AdminAuthError) {
      deauthenticate()
      return true
    }
    return false
  }

  const lookup = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    setMember(null)
    fetchMember({ email, password })
      .then((result) => {
        if (result === null) {
          setError('No member found for that email.')
        } else {
          setMember(result)
        }
      })
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Lookup failed.')
        }
      })
      .finally(() => setBusy(false))
  }

  const applyTier = (tier: PaidTier) => {
    if (!member) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    reissueInvite({ email: member.email, tier, password })
      .then((result) => setStatus(`Reset to ${tier}. Send this re-join link: ${result.url}`))
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Could not reset tier.')
        }
      })
      .finally(() => setBusy(false))
  }

  const applyExpiry = (days: number | null) => {
    if (!member) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    resetExpiry({ email: member.email, days, password })
      .then(() => setStatus(days === null ? 'Expiry cleared.' : `Expiry set to ${days} days.`))
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Could not set expiry.')
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Reset a member</h1>
      <form className={styles.lookup} onSubmit={lookup}>
        <input
          className={styles.input}
          type="email"
          placeholder="member@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className={styles.button} type="submit" disabled={!valid || busy}>
          Find
        </button>
      </form>
      {!!error && <p className={styles.error}>{error}</p>}
      {!!status && <p className={styles.status}>{status}</p>}
      {!!member && (
        <section className={styles.member}>
          <p className={styles.summary}>
            {member.member} — {member.email} ({member.tier})
          </p>
          <div className={styles.group}>
            <p className={styles.groupLabel}>
              Set tier — disables + re-invites; member must re-open the link
            </p>
            <div className={styles.buttons}>
              {TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className={styles.preset}
                  onClick={() => applyTier(tier)}
                  disabled={busy}
                >
                  {tier}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.group}>
            <p className={styles.groupLabel}>Set expiry — instant, in place</p>
            <div className={styles.buttons}>
              {EXPIRY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={styles.preset}
                  onClick={() => applyExpiry(preset.days)}
                  disabled={busy}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

const ResetUser = () => (
  <AdminGate title="Westeroz — Reset user">
    <ResetUserInner />
  </AdminGate>
)

export default ResetUser
```

Create `web/src/pages/ResetUser/ResetUser.module.scss`:

```scss
.page {
  display: grid;
  gap: var(--space-3);
  max-width: 40rem;
  margin-inline: auto;
  padding: var(--space-4) var(--space-3);
}

.title {
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
  font-weight: 700;
}

.lookup {
  display: flex;
  gap: var(--space-2);
}

.input {
  flex: 1;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
}

.button {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-weight: 600;
  cursor: pointer;

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.error {
  color: var(--color-kids);
}

.status {
  color: var(--color-accent);
  word-break: break-all;
}

.member {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.summary {
  font-weight: 600;
}

.group {
  display: grid;
  gap: var(--space-2);
}

.groupLabel {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
}

.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.preset {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  text-transform: capitalize;
  cursor: pointer;

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/pages/ResetUser/ResetUser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ResetUser/
git commit -m "WZ: Add /reset-user page"
```

---

### Task 12: Routing + release wiring + full verify

**Files:**

- Create: `web/src/AppRoutes.tsx`, `web/src/AppRoutes.test.tsx`, `web/public/_redirects`
- Modify: `web/src/main.tsx`, `web/.env.example`, `web/package.json` (dep)

**Interfaces:**

- Consumes: `Manage` (Task 10), `ResetUser` (Task 11), existing `App`.

- [ ] **Step 1: Install react-router-dom**

Run: `cd web && npm install react-router-dom@^7`
Expected: `react-router-dom` added to `dependencies`.

- [ ] **Step 2: Write the failing test** — create `web/src/AppRoutes.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'vitest'
import AppRoutes from '@/AppRoutes'

afterEach(() => {
  sessionStorage.clear()
})

test('renders the landing page at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Choose your tier' })).toBeInTheDocument()
})

test('renders the admin gate at /manage', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd web && npx vitest run src/AppRoutes.test.tsx`
Expected: FAIL (`@/AppRoutes` not found).

- [ ] **Step 4: Implement**

Create `web/src/AppRoutes.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'
import App from '@/App'
import Manage from '@/pages/Manage/Manage'
import ResetUser from '@/pages/ResetUser/ResetUser'

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
  </Routes>
)

export default AppRoutes
```

Replace `web/src/main.tsx` with:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource/silkscreen'
import AppRoutes from '@/AppRoutes'
import '@/styles/globals.scss'

const rootElement = document.getElementById('root')

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </StrictMode>,
  )
}
```

Create `web/public/_redirects` (SPA fallback so deep links resolve on Netlify):

```
/*  /index.html  200
```

Append to `web/.env.example`:

```bash
# Base URL of the stripe-bridge admin API used by /manage and /reset-user.
# Behind Tailscale Funnel, which strips the /stripe prefix before the bridge.
VITE_ADMIN_API_BASE=https://meleys.tail5586d4.ts.net/stripe
```

- [ ] **Step 5: Run to verify pass**

Run: `cd web && npx vitest run src/AppRoutes.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full verification (all gates green)**

Run each; all must pass:

```bash
cd web && npm run test          # full vitest suite (existing + new)
cd web && npm run typecheck     # tsc, no errors
cd web && npm run build         # tsc && vite build succeeds
cd .. && npx eslint web/src     # lint clean (no `any`/`as`/relative-import violations)
cd stripe-bridge && python -m pytest tests/ -v   # full bridge suite
```

Expected: every command exits 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/AppRoutes.tsx web/src/AppRoutes.test.tsx web/src/main.tsx web/public/_redirects web/.env.example web/package.json web/package-lock.json
git commit -m "WZ: Route /manage + /reset-user and wire admin API base"
```

---

## Post-implementation (operator, out of band)

Not code — do NOT block the plan on these, but the pages are inert until they're done:

1. Set `ADMIN_PASSWORD` and `ADMIN_ALLOWED_ORIGINS` (the real Netlify origin) in the NAS `.env`; force-recreate the bridge so `admin.py` + CORS load.
2. Set `VITE_ADMIN_API_BASE` in the Netlify dashboard; redeploy the web build.
3. Confirm Funnel serves `/stripe/admin/members` (behind the password) end-to-end.

## Self-Review notes

- **Spec coverage:** routing (T12), auth gate (T8), members endpoint + dedupe + tier join + derived downloads (T4), member lookup (T4), reset-expiry (T5), reissue-invite fail-closed (T5), tier persistence (T1–T2), `list_users` (T3), CORS + mount + Dockerfile + env (T6), `/manage` table + pagination + invite (T9–T10), `/reset-user` presets + email validation (T11), `_redirects` (T12), null-expiry open risk (T5 Step 5). All spec sections map to a task.
- **Types:** `Member`/`PaidTier`/`Tier` defined in T7 and reused verbatim in T9–T11; bridge `Member` dict keys match the TS `Member` fields; `reissueInvite`/`resetExpiry`/`fetchMember` signatures identical across definition (T7) and callers (T10–T11).
- **No placeholders:** every code + test step is complete; the one conditional (null-expiry fallback) has explicit fallback instructions, not a TODO.
