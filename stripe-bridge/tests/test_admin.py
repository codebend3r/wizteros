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


def test_list_members_includes_subscribers_not_yet_joined(admin_db):
    a, dbp = admin_db
    # a Stripe subscriber the bridge knows who never redeemed a Wizarr invite
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="kids")
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert "max@x.com" in by_email  # shown despite having no Wizarr record
    mx = by_email["max@x.com"]
    assert mx["tier"] == "kids"
    assert mx["downloads"] is True    # derived from kids
    assert mx["subscribed"] is False  # no expiry -> Invite button in the UI
    assert mx["servers"] == []


def test_get_member_falls_back_to_subscriber(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="kids")
    m = a.get_member("max@x.com")
    assert m["email"].lower() == "max@x.com"
    assert m["tier"] == "kids"
    assert m["subscribed"] is False
    with pytest.raises(HTTPException) as missing:
        a.get_member("nobody@nowhere.com")  # in neither Wizarr nor customer_map
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


def test_reissue_invite_creates_then_disables_scoped_invite(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_user_ids_by_email.return_value = [9, 12]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))

    assert a.client.disable_user.call_count == 2  # both existing records dropped
    # private 99. library excluded, non-4k allowed for silver -> ids 17 + 20
    a.client.create_invite.assert_called_once_with(
        [1], 7, "35", library_ids=[17, 20], allow_downloads=False)
    # invite must be created BEFORE any disable, so a create failure can't lock
    # the member out with no link to re-redeem
    order = [c[0] for c in a.client.method_calls]
    assert order.index("create_invite") < order.index("disable_user")
    assert out["disabled"] == 2
    assert out["code"] == "xyz"
    assert out["url"] == "http://inv.test/j/xyz"  # public URL, not the LAN one
    assert out["tier"] == "silver"


def test_reissue_invite_keeps_member_visible_as_pending(admin_db):
    a, dbp = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_user_ids_by_email.return_value = [9]
    a.client.create_invite.return_value = {"code": "NEW1", "url": "http://wizarr-lan/j/NEW1"}
    a.reissue_invite(a.ReissueInviteBody(email="Code@X.com", tier="gold"))

    # disable severs the plex.tv friendship, so Wizarr drops the records
    a.client.list_users.return_value = []
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert "code@x.com" in by_email  # still listed while the invite is pending
    assert by_email["code@x.com"]["tier"] == "gold"
    assert by_email["code@x.com"]["subscribed"] is False


def test_reissue_invite_fails_closed_without_public_base(admin_db, monkeypatch):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_user_ids_by_email.return_value = [9]
    monkeypatch.setattr(a, "PUBLIC_INVITE_BASE", "")
    with pytest.raises(HTTPException) as e:
        a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))
    assert e.value.status_code == 500
    a.client.disable_user.assert_not_called()  # fails before any destructive action


def test_bridge_app_mounts_admin_routes_bare_and_prefixed():
    os.environ.update({
        "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
        "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
        "SMTP_PASS": "p", "FROM_ADDR": "server@test",
        "MAP_DB_PATH": "/tmp/mount-test.db",
    })
    import stripe_wizarr_bridge as b
    importlib.reload(b)
    # openapi()["paths"] rather than walking b.app.routes directly: installed
    # fastapi>=0.139 represents each include_router()-mounted router as an
    # opaque _IncludedRouter wrapper on app.routes with no .path attribute
    # until resolved; openapi() is the stable, version-safe flattened view.
    paths = set(b.app.openapi()["paths"])
    assert "/admin/members" in paths
    assert "/stripe/admin/members" in paths
    assert "/admin/reissue-invite" in paths
