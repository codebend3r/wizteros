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


def test_require_admin_fails_closed_when_password_unset(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a, "ADMIN_PASSWORD", "")
    with pytest.raises(HTTPException) as e:
        a.require_admin("secret")  # even the "right" value is rejected when no password is configured
    assert e.value.status_code == 401


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


def test_reissue_invite_fails_closed_without_public_base(admin_db, monkeypatch):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_user_ids_by_email.return_value = [9]
    monkeypatch.setattr(a, "PUBLIC_INVITE_BASE", "")
    with pytest.raises(HTTPException) as e:
        a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))
    assert e.value.status_code == 500
    a.client.disable_user.assert_not_called()  # fails before any destructive action
