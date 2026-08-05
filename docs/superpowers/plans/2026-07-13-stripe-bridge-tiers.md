# Stripe-Bridge Two-Tier Subscription, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `stripe-bridge` service so paying subscribers get their Plex access auto-renewed each billing cycle and disabled (not deleted) on cancellation, backed by a durable Stripe↔Wizarr identity mapping, while the free family/VIP tier stays entirely manual in Wizarr.

**Architecture:** The bridge is a small FastAPI app that receives Stripe webhooks and calls Wizarr's REST API. This plan splits the current single file into three focused modules, `store.py` (SQLite identity mapping), `wizarr.py` (Wizarr API client), and `stripe_wizarr_bridge.py` (FastAPI app + webhook routing + email), and adds an `invoice.paid` renewal path. Identity is resolved by a cached `stripe_customer_id → wizarr_user_id` map, with email and invite-code fallbacks.

**Tech Stack:** Python 3.12, FastAPI, `stripe` SDK, `requests`, stdlib `sqlite3`, `smtplib`. Tests: `pytest` + `responses` (HTTP mocking).

## Global Constraints

- Repo: `codebend3r/wizteros`. Bridge code lives under `stripe-bridge/`.
- All commits: short subject, optional bullet body. **No `Co-Authored-By` or agent-attribution trailers** (per repo `CLAUDE.md`).
- **User-facing copy (product names, emails, confirmation text) must use infrastructure/hosting language only, never reference Plex, libraries, or media titles** (Plex + Stripe TOS).
- The bridge is intentionally small: no ORM, no framework beyond FastAPI, no queue. SQLite via stdlib only.
- The bridge runs standalone and points at the operator's **existing** Wizarr at `http://192.168.50.141:5690` (3 Plex servers already configured). The local `/Users/snowball/Docker/docker-compose.yml` is out of scope, do not touch it.
- `ACCESS_DURATION` (default `35`) is the per-cycle grant length in days, reused as the renewal extend increment. `INVITE_EXPIRES_DAYS` (default `7`) is how long the invite link stays valid.
- Wizarr auth header: `X-API-Key: <key>`.
- Test email for the end-to-end flow: `codebenderinc@gmail.com` (operator's second inbox).

### Verified Wizarr API (against wizarrrr/wizarr `main`)

- `POST /api/invitations` → body `{"server_ids":[int], "expires_in_days":int, "duration":str|int, "unlimited":bool}`; `201` → `{"invitation": {"id", "code", "url", ...}}`. Note `expires_in_days` only maps `{1,7,30}`→`day/week/month`, else "never".
- `GET /api/users?email=<e>` / `?username=<u>` → `{"users":[{"id","username","email","expires",...}], "count"}` (server-side filtered).
- `GET /api/invitations` → `{"invitations":[{"code","used_by","used_at",...}]}` (`used_by` = redeeming username).
- `POST /api/users/{id}/extend` → body `{"days":int}` → `{"message","new_expiry"}` (adds to existing expiry).
- `POST /api/users/{id}/disable` → `{"message":...}`.

---

### Task 1: SQLite identity store (`store.py`)

**Files:**

- Create: `stripe-bridge/store.py`
- Test: `stripe-bridge/tests/test_store.py`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `init_db(path: str) -> None`
  - `upsert_pending(path: str, stripe_customer_id: str, email: str, invite_code: str) -> None`: inserts a row with `wizarr_user_id = NULL`; on conflict updates `email`/`invite_code`.
  - `set_user_id(path: str, stripe_customer_id: str, wizarr_user_id: int) -> None`
  - `get_mapping(path: str, stripe_customer_id: str) -> dict | None`: returns `{"stripe_customer_id","email","invite_code","wizarr_user_id"}` or `None`.

- [ ] **Step 1: Write the failing test**

```python
# stripe-bridge/tests/test_store.py
import store


def test_upsert_get_and_backfill(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.get_mapping(db, "cus_1") is None

    store.upsert_pending(db, "cus_1", "a@example.com", "abc123")
    m = store.get_mapping(db, "cus_1")
    assert m == {
        "stripe_customer_id": "cus_1",
        "email": "a@example.com",
        "invite_code": "abc123",
        "wizarr_user_id": None,
    }

    # upsert again updates email, keeps row unique
    store.upsert_pending(db, "cus_1", "b@example.com", "abc123")
    assert store.get_mapping(db, "cus_1")["email"] == "b@example.com"

    # backfill resolved user id
    store.set_user_id(db, "cus_1", 42)
    assert store.get_mapping(db, "cus_1")["wizarr_user_id"] == 42
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_store.py -v`
Expected: FAIL: `ModuleNotFoundError: No module named 'store'`

- [ ] **Step 3: Write minimal implementation**

```python
# stripe-bridge/store.py
import sqlite3

_SCHEMA = """
CREATE TABLE IF NOT EXISTS customer_map (
    stripe_customer_id TEXT PRIMARY KEY,
    email              TEXT,
    invite_code        TEXT,
    wizarr_user_id     INTEGER
)
"""


def _conn(path: str) -> sqlite3.Connection:
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


def init_db(path: str) -> None:
    with _conn(path) as c:
        c.execute(_SCHEMA)


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


def get_mapping(path: str, stripe_customer_id: str) -> dict | None:
    with _conn(path) as c:
        row = c.execute(
            "SELECT stripe_customer_id, email, invite_code, wizarr_user_id "
            "FROM customer_map WHERE stripe_customer_id = ?",
            (stripe_customer_id,),
        ).fetchone()
    return dict(row) if row else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stripe-bridge && python -m pytest tests/test_store.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/store.py stripe-bridge/tests/test_store.py
git commit -m "Add SQLite identity store for stripe-bridge

- customer_map: stripe_customer_id -> wizarr_user_id with email/invite fallbacks"
```

---

### Task 2: Wizarr API client (`wizarr.py`)

**Files:**

- Create: `stripe-bridge/wizarr.py`
- Test: `stripe-bridge/tests/test_wizarr.py`

**Interfaces:**

- Consumes: nothing.
- Produces a `WizarrClient` class:
  - `__init__(self, base_url: str, api_key: str, server_id: int)`
  - `create_invite(self, expires_in_days: int, duration, unlimited: bool = False) -> dict`: returns `{"code": str, "url": str}`
  - `find_user_id_by_email(self, email: str) -> int | None`
  - `find_user_id_by_invite(self, code: str) -> int | None`: resolves via `GET /api/invitations` → `used_by` → `GET /api/users?username=`
  - `extend_user(self, user_id: int, days: int) -> None`
  - `disable_user(self, user_id: int) -> None`

- [ ] **Step 1: Write the failing test**

```python
# stripe-bridge/tests/test_wizarr.py
import responses
from wizarr import WizarrClient

BASE = "http://wizarr.test"


def client():
    return WizarrClient(BASE, "key", server_id=1)


@responses.activate
def test_create_invite_returns_code_and_url():
    responses.post(
        f"{BASE}/api/invitations",
        json={"invitation": {"id": 5, "code": "abc123",
                             "url": f"{BASE}/j/abc123"}},
        status=201,
    )
    out = client().create_invite(expires_in_days=7, duration="35")
    assert out == {"code": "abc123", "url": f"{BASE}/j/abc123"}


@responses.activate
def test_find_user_id_by_email_hit_and_miss():
    responses.get(f"{BASE}/api/users",
                  json={"users": [{"id": 9, "username": "cj", "email": "a@x.com"}]})
    assert client().find_user_id_by_email("a@x.com") == 9

    responses.reset()
    responses.get(f"{BASE}/api/users", json={"users": []})
    assert client().find_user_id_by_email("nope@x.com") is None


@responses.activate
def test_find_user_id_by_invite_walks_used_by():
    responses.get(f"{BASE}/api/invitations",
                  json={"invitations": [{"code": "abc123", "used_by": "cj"}]})
    responses.get(f"{BASE}/api/users",
                  json={"users": [{"id": 9, "username": "cj", "email": "a@x.com"}]})
    assert client().find_user_id_by_invite("abc123") == 9


@responses.activate
def test_extend_and_disable_call_correct_paths():
    responses.post(f"{BASE}/api/users/9/extend",
                   json={"message": "ok", "new_expiry": "2026-09-01"})
    responses.post(f"{BASE}/api/users/9/disable", json={"message": "ok"})
    client().extend_user(9, 35)
    client().disable_user(9)
    assert responses.calls[0].request.url == f"{BASE}/api/users/9/extend"
    assert responses.calls[1].request.url == f"{BASE}/api/users/9/disable"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_wizarr.py -v`
Expected: FAIL: `ModuleNotFoundError: No module named 'wizarr'`

- [ ] **Step 3: Write minimal implementation**

```python
# stripe-bridge/wizarr.py
import requests


class WizarrClient:
    def __init__(self, base_url: str, api_key: str, server_id: int):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.server_id = server_id

    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def create_invite(self, expires_in_days: int, duration, unlimited: bool = False) -> dict:
        r = requests.post(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            json={
                "server_ids": [self.server_id],
                "expires_in_days": expires_in_days,
                "duration": duration,
                "unlimited": unlimited,
            },
            timeout=10,
        )
        r.raise_for_status()
        inv = r.json()["invitation"]
        return {"code": inv["code"], "url": inv["url"]}

    def _users(self, params: dict) -> list:
        r = requests.get(
            f"{self.base_url}/api/users",
            headers=self._headers(),
            params=params,
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("users", [])

    def find_user_id_by_email(self, email: str) -> int | None:
        for u in self._users({"email": email}):
            return u["id"]
        return None

    def find_user_id_by_invite(self, code: str) -> int | None:
        r = requests.get(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        used_by = None
        for inv in r.json().get("invitations", []):
            if inv.get("code") == code:
                used_by = inv.get("used_by")
                break
        if not used_by:
            return None
        for u in self._users({"username": used_by}):
            return u["id"]
        return None

    def extend_user(self, user_id: int, days: int) -> None:
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/extend",
            headers=self._headers(),
            json={"days": days},
            timeout=10,
        )
        r.raise_for_status()

    def disable_user(self, user_id: int) -> None:
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/disable",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stripe-bridge && python -m pytest tests/test_wizarr.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add stripe-bridge/wizarr.py stripe-bridge/tests/test_wizarr.py
git commit -m "Add Wizarr API client with email + invite-code user resolution

- create_invite, extend_user, disable_user
- find_user_id_by_email and find_user_id_by_invite (via used_by)"
```

---

### Task 3: Rewrite webhook app to use store + client, add renewal path

**Files:**

- Modify (full rewrite): `stripe-bridge/stripe_wizarr_bridge.py`
- Test: `stripe-bridge/tests/test_bridge.py`

**Interfaces:**

- Consumes: `store` (Task 1), `WizarrClient` (Task 2).
- Produces:
  - `resolve_user_id(client, store_path, customer_id, email) -> int | None`: cache → email → invite fallback, backfills cache on hit.
  - FastAPI `app` with `POST /stripe/webhook` handling `checkout.session.completed`, `invoice.paid` (skip `billing_reason == "subscription_create"`), `customer.subscription.deleted`.
  - `handle_event(event: dict) -> None`: pure routing over the parsed event, so tests bypass signature verification.

**Behavior:**

- `checkout.session.completed`: email from `customer_details.email`/`customer_email`; create invite; `store.upsert_pending(customer_id, email, code)`; email the invite link.
- `invoice.paid`: if `billing_reason == "subscription_create"` → skip (first charge coincides with signup). Else resolve user and `extend_user(uid, int(ACCESS_DURATION))`.
- `customer.subscription.deleted`: resolve user and `disable_user(uid)`.

- [ ] **Step 1: Write the failing test**

```python
# stripe-bridge/tests/test_bridge.py
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# Provide required env before importing the module.
os.environ.update({
    "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "WIZARR_SERVER_ID": "1", "INVITE_EXPIRES_DAYS": "7", "ACCESS_DURATION": "35",
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test", "PUBLIC_INVITE_BASE": "http://inv.test",
    "MAP_DB_PATH": "/tmp/does-not-matter.db",
})


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    import importlib
    import stripe_wizarr_bridge as b
    importlib.reload(b)
    dbp = str(tmp_path / "bridge.db")
    monkeypatch.setattr(b, "MAP_DB_PATH", dbp)
    import store
    store.init_db(dbp)
    b.client = MagicMock()
    monkeypatch.setattr(b, "send_invite_email", MagicMock())
    return b


def test_checkout_creates_invite_and_stores_mapping(bridge):
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://inv.test/j/abc"}
    bridge.handle_event({
        "type": "checkout.session.completed",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    bridge.client.create_invite.assert_called_once()
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")
    import store
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["invite_code"] == "abc"


def test_invoice_paid_first_charge_is_skipped(bridge):
    bridge.handle_event({
        "type": "invoice.paid",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_create"}},
    })
    bridge.client.extend_user.assert_not_called()


def test_invoice_paid_renewal_extends(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_id_by_email.return_value = 9
    bridge.handle_event({
        "type": "invoice.paid",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    bridge.client.extend_user.assert_called_once_with(9, 35)


def test_subscription_deleted_disables_user(bridge, monkeypatch):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_id_by_email.return_value = 9
    monkeypatch.setattr(bridge, "customer_email", lambda cid: "a@x.com")
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "data": {"object": {"customer": "cus_1"}},
    })
    bridge.client.disable_user.assert_called_once_with(9)


def test_resolve_prefers_cache_then_email_then_invite(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    # email miss, invite hit -> backfills cache
    bridge.client.find_user_id_by_email.return_value = None
    bridge.client.find_user_id_by_invite.return_value = 7
    uid = bridge.resolve_user_id(bridge.client, bridge.MAP_DB_PATH, "cus_1", "a@x.com")
    assert uid == 7
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["wizarr_user_id"] == 7
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd stripe-bridge && python -m pytest tests/test_bridge.py -v`
Expected: FAIL: `AttributeError`/`ImportError` (no `handle_event`, `resolve_user_id`, `customer_email`, or `MAP_DB_PATH`).

- [ ] **Step 3: Write minimal implementation (full file)**

```python
# stripe-bridge/stripe_wizarr_bridge.py
import logging
import os
import smtplib
from email.message import EmailMessage

import stripe
from fastapi import FastAPI, Header, HTTPException, Request

import store
from wizarr import WizarrClient

STRIPE_API_KEY = os.environ["STRIPE_API_KEY"]
STRIPE_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

WIZARR_BASE_URL = os.environ["WIZARR_BASE_URL"].rstrip("/")
WIZARR_API_KEY = os.environ["WIZARR_API_KEY"]
WIZARR_SERVER_ID = int(os.environ.get("WIZARR_SERVER_ID", "1"))
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "7"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")

SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASS = os.environ["SMTP_PASS"]
FROM_ADDR = os.environ.get("FROM_ADDR", SMTP_USER)
PUBLIC_INVITE_BASE = os.environ["PUBLIC_INVITE_BASE"].rstrip("/")

MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")

stripe.api_key = STRIPE_API_KEY
log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY, WIZARR_SERVER_ID)
store.init_db(MAP_DB_PATH)

app = FastAPI()


def send_invite_email(to_addr: str, invite_url: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = "Your server access link"
    msg["From"] = FROM_ADDR
    msg["To"] = to_addr
    msg.set_content(
        f"""Thanks for contributing to server costs!

Click the link below to set up your account. The invite expires in {INVITE_DAYS} days,
so please complete signup soon.

  {invite_url}

If you cancel your contribution, access will be removed at the end of the current cycle.
""".strip()
    )
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


def customer_email(customer_id: str) -> str | None:
    return stripe.Customer.retrieve(customer_id).get("email")


def resolve_user_id(client, store_path: str, customer_id: str, email: str | None) -> int | None:
    m = store.get_mapping(store_path, customer_id)
    if m and m["wizarr_user_id"]:
        return m["wizarr_user_id"]
    uid = client.find_user_id_by_email(email) if email else None
    if not uid and m and m["invite_code"]:
        uid = client.find_user_id_by_invite(m["invite_code"])
    if uid:
        store.set_user_id(store_path, customer_id, uid)
    return uid


def handle_event(event: dict) -> None:
    etype = event["type"]
    obj = event["data"]["object"]
    log.info("stripe event: %s", etype)

    if etype == "checkout.session.completed":
        email = (obj.get("customer_details") or {}).get("email") or obj.get("customer_email")
        customer_id = obj.get("customer")
        if not email:
            log.warning("no email on session %s", obj.get("id"))
            return
        invite = client.create_invite(INVITE_DAYS, ACCESS_DURATION)
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, invite["code"])
        send_invite_email(email, invite["url"])
        log.info("sent invite to %s", email)

    elif etype == "invoice.paid":
        if obj.get("billing_reason") == "subscription_create":
            log.info("skipping first (signup) invoice for %s", obj.get("customer"))
            return
        customer_id = obj["customer"]
        email = obj.get("customer_email") or customer_email(customer_id)
        uid = resolve_user_id(client, MAP_DB_PATH, customer_id, email)
        if uid:
            client.extend_user(uid, int(ACCESS_DURATION))
            log.info("extended user %s (+%s days)", uid, ACCESS_DURATION)
        else:
            log.warning("renewal: no wizarr user for %s / %s", customer_id, email)

    elif etype == "customer.subscription.deleted":
        customer_id = obj["customer"]
        email = customer_email(customer_id)
        uid = resolve_user_id(client, MAP_DB_PATH, customer_id, email)
        if uid:
            client.disable_user(uid)
            log.info("disabled user %s (%s)", uid, email)
        else:
            log.info("cancel: no wizarr user for %s / %s", customer_id, email)


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")
    handle_event(event)
    return {"ok": True}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd stripe-bridge && python -m pytest tests/test_bridge.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Run the whole suite**

Run: `cd stripe-bridge && python -m pytest -v`
Expected: PASS (all tests from Tasks 1, 3)

- [ ] **Step 6: Commit**

```bash
git add stripe-bridge/stripe_wizarr_bridge.py stripe-bridge/tests/test_bridge.py
git commit -m "Rewrite bridge: renewal extend, cancel=disable, durable identity map

- invoice.paid extends access each cycle (skips first signup invoice)
- customer.subscription.deleted now disables (was delete)
- resolve_user_id: cache -> email -> invite-code fallback, backfills cache
- handle_event split out from webhook for testability"
```

---

### Task 4: Dev/runtime dependencies, Dockerfile, and env

**Files:**

- Create: `stripe-bridge/requirements.txt`, `stripe-bridge/requirements-dev.txt`, `stripe-bridge/pytest.ini`
- Modify: `stripe-bridge/Dockerfile`
- Modify: `.env.example`

**Interfaces:** none (config only).

- [ ] **Step 1: Create requirements files**

```text
# stripe-bridge/requirements.txt
fastapi
uvicorn[standard]
stripe
requests
```

```text
# stripe-bridge/requirements-dev.txt
-r requirements.txt
pytest
responses
```

- [ ] **Step 2: Create pytest config so bare module imports resolve**

```ini
# stripe-bridge/pytest.ini
[pytest]
pythonpath = .
testpaths = tests
```

- [ ] **Step 3: Update the Dockerfile to use requirements and mount the DB dir**

```dockerfile
# stripe-bridge/Dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY store.py wizarr.py stripe_wizarr_bridge.py .
ENV MAP_DB_PATH=/data/bridge.db
VOLUME ["/data"]
CMD ["uvicorn", "stripe_wizarr_bridge:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Add `MAP_DB_PATH` to `.env.example`**

Add this line under the Wizarr block in `.env.example`:

```text
MAP_DB_PATH=/data/bridge.db
```

- [ ] **Step 5: Verify a clean dev install + full suite passes**

Run:

```bash
cd stripe-bridge && python -m venv .venv && . .venv/bin/activate \
  && pip install -q -r requirements-dev.txt && python -m pytest -v
```

Expected: PASS (all tests). Then `deactivate`.

- [ ] **Step 6: Commit**

```bash
printf '.venv/\n__pycache__/\n*.db\n' >> .gitignore
git add stripe-bridge/requirements.txt stripe-bridge/requirements-dev.txt \
  stripe-bridge/pytest.ini stripe-bridge/Dockerfile .env.example .gitignore
git commit -m "Pin bridge deps, add pytest config, mount SQLite volume

- split runtime vs dev requirements; Dockerfile installs from requirements.txt
- /data volume for bridge.db; MAP_DB_PATH documented in .env.example"
```

---

### Task 5: Manual end-to-end local test (real checkout → invite → Plex signup)

**Files:** none (verification task). Uses the operator's real second inbox `codebenderinc@gmail.com`.

**Preconditions:**

- Wizarr API key generated (Wizarr → Settings → API Keys).
- A local `.env` created from `.env.example` with real values: `WIZARR_BASE_URL=http://192.168.50.141:5690`, the Wizarr API key, working SMTP creds (Gmail app password or Titan), Stripe **test** secret key. Leave `STRIPE_WEBHOOK_SECRET` blank for now.

- [ ] **Step 1: Build and run the bridge locally**

```bash
cd stripe-bridge
docker build -t stripe-bridge .
docker run --rm -p 8000:8000 --env-file ../.env -v "$PWD/data:/data" stripe-bridge
```

Expected: uvicorn logs `Application startup complete` on `:8000`.

- [ ] **Step 2: Forward Stripe test events to the local bridge**

In a second terminal:

```bash
stripe listen --forward-to localhost:8000/stripe/webhook \
  --events checkout.session.completed,invoice.paid,customer.subscription.deleted
```

Copy the `whsec_...` it prints, put it in `.env` as `STRIPE_WEBHOOK_SECRET`, and restart the `docker run` from Step 1 so the signature check passes.

- [ ] **Step 3: Drive a real checkout with the test inbox**

Open the test Payment Link `https://buy.stripe.com/test_bJe6oG2Yte2m7l1f721Nu00`, enter `codebenderinc@gmail.com` as the email, pay with test card `4242 4242 4242 4242` (any future expiry, any CVC).
Expected: `stripe listen` shows `checkout.session.completed` forwarded → bridge logs `sent invite to codebenderinc@gmail.com`. The first `invoice.paid` (subscription_create) logs `skipping first (signup) invoice`.

- [ ] **Step 4: Verify the invite email and complete Plex signup**

Check the `codebenderinc@gmail.com` inbox for the "Your server access link" email, click the link, and complete Wizarr's Plex onboarding.
Expected: the account appears under Wizarr → Users with an `expires` ~35 days out.

- [ ] **Step 5: Verify renewal extends access**

Simulate a renewal charge:

```bash
stripe trigger invoice.paid --add invoice:billing_reason=subscription_cycle
```

(If the synthetic customer doesn't match, instead advance the test clock / create a renewal on the real subscription in the dashboard so `customer_email` is `codebenderinc@gmail.com`.)
Expected: bridge logs `extended user <id> (+35 days)`; the user's `expires` in Wizarr moves ~35 days further out.

- [ ] **Step 6: Verify cancellation disables access**

In the Stripe **test** dashboard → Subscriptions → cancel the `codebenderinc@gmail.com` subscription immediately.
Expected: `customer.subscription.deleted` forwarded → bridge logs `disabled user <id>`; the user shows as disabled in Wizarr and loses Plex access.

- [ ] **Step 7: Record the result**

No commit needed. Note pass/fail of Steps 3, 6 in the plan checklist. If any step fails, debug before Phase 2. Do **not** proceed to live keys until Steps 3, 4, and 6 all pass.

---

### Task 6 (DEFERRED: Phase 2 go-live): Cloudflare Tunnel + live keys

Do **not** start until Task 5 passes. Tracked here so it isn't lost; expand into its own plan when ready.

- Migrate `cjrivas.io` DNS to Cloudflare; swap nameservers at name.com.
- Create a Cloudflare Tunnel; add a `cloudflared` service (wherever the bridge will run in production) routing `webhook.cjrivas.io → bridge:8000` (and optionally `invite.cjrivas.io → wizarr:5690`).
- In the Stripe **live** dashboard: recreate the product + Payment Link, add a webhook endpoint at `https://webhook.cjrivas.io/stripe/webhook` for the three events, copy its signing secret to the live `.env`.
- Switch the bridge to Stripe **live** keys. Smoke-test one real $1-ish transaction or a live test with the operator's own card, then invite a small trusted group.
- Free tier stays manual: generate unlimited-duration Wizarr invites directly in the admin UI for family/VIP.

---

## Self-Review

- **Spec coverage:** Two-tier model → free tier stays manual (Task 6 note; no code needed). Paid pipeline `checkout/invoice.paid/subscription.deleted` → Task 3. `invoice.paid` extend + skip-first → Task 3. Cancel=disable → Task 3. SQLite identity map → Tasks 1 & 3. Verified Wizarr endpoints → Tasks 2. Config/volume/env → Task 4. Local Stripe-CLI test with `codebenderinc@gmail.com` → Task 5. Go-live → Task 6. All spec sections mapped.
- **Placeholder scan:** No TBD/TODO; every code step shows full code; the one deferred task (6) is explicitly labeled deferred, not a hidden placeholder.
- **Type consistency:** `create_invite` returns `{"code","url"}` (Task 2) and is consumed as `invite["code"]`/`invite["url"]` (Task 3). `resolve_user_id`, `handle_event`, `customer_email`, `MAP_DB_PATH` defined in Task 3 and exercised by Task 3 tests. `store` function names match across Tasks 1 & 3. `extend_user(uid, int(ACCESS_DURATION))` matches `extend_user(self, user_id, days)`.
