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
