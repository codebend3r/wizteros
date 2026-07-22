import importlib
import os
from unittest.mock import MagicMock

import pytest

# Env required before importing the module (mirrors test_bridge).
os.environ.update({
    "ADMIN_PASSWORD": "secret",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "INVITE_EXPIRES_DAYS": "14", "ACCESS_DURATION": "35",
    "PUBLIC_INVITE_BASE": "http://inv.test",
    "SMTP_HOST": "smtp.test", "SMTP_USER": "u", "SMTP_PASS": "p",
})

import admin  # noqa: E402
import store  # noqa: E402
from fastapi import HTTPException  # noqa: E402

USERS = [
    {"id": 1, "username": "cj", "email": "A@X.com", "server": "Meleys", "expires": "2026-09-01T00:00:00+00:00"},
    {"id": 2, "username": "cj", "email": "a@x.com", "server": "Vhagar", "expires": "2026-09-10T00:00:00+00:00"},
    {"id": 3, "username": "nora", "email": "nora@x.com", "server": "Syrax", "expires": None},
]

LIBRARIES = [
    {"id": 1, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 2, "name": "03. 4K Movies", "server_id": 3, "server_name": "Vhagar", "enabled": True},
    {"id": 3, "name": "90. Private", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 4, "name": "02. Anime", "server_id": 5, "server_name": "Syrax", "enabled": False},
]


@pytest.fixture
def admin_db(tmp_path, monkeypatch):
    importlib.reload(admin)
    dbp = str(tmp_path / "bridge.db")
    store.init_db(dbp)
    monkeypatch.setattr(admin, "MAP_DB_PATH", dbp)
    monkeypatch.setattr(admin, "send_invite_email", MagicMock(), raising=False)
    admin.client = MagicMock()
    admin.client.list_users.return_value = USERS
    admin.client.list_libraries.return_value = LIBRARIES
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
    # per-server access derives from tier rules; 90. private never shown
    assert cj["libraries"] == {"Meleys": ["01. Movies"], "Vhagar": ["03. 4K Movies"]}

    nora = by_email["nora@x.com"]
    assert nora["subscribed"] is False
    assert nora["tier"] == "unknown"
    assert nora["downloads"] is None
    assert nora["libraries"] == {"Syrax": []}  # unknown tier grants nothing


def test_get_member_found_and_missing(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    found = a.get_member("a@x.com")
    assert found["member"] == "cj"
    assert found["libraries"] == {"Meleys": ["01. Movies"], "Vhagar": ["03. 4K Movies"]}
    with pytest.raises(HTTPException) as missing:
        a.get_member("ghost@x.com")
    assert missing.value.status_code == 404


def test_list_members_includes_subscribers_not_yet_joined(admin_db):
    a, dbp = admin_db
    # a Stripe subscriber the bridge knows who never redeemed a Wizarr invite
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="youth")
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert "max@x.com" in by_email  # shown despite having no Wizarr record
    mx = by_email["max@x.com"]
    assert mx["tier"] == "youth"
    assert mx["downloads"] is True    # derived from youth
    assert mx["subscribed"] is False  # no expiry -> Invite button in the UI
    assert mx["servers"] == []
    assert mx["libraries"] == {}      # not on any server yet
    assert mx["invited_at"] is not None  # upsert stamped the grace clock


def test_get_member_falls_back_to_subscriber(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="youth")
    m = a.get_member("max@x.com")
    assert m["email"].lower() == "max@x.com"
    assert m["tier"] == "youth"
    assert m["subscribed"] is False
    with pytest.raises(HTTPException) as missing:
        a.get_member("nobody@nowhere.com")  # in neither Wizarr nor customer_map
    assert missing.value.status_code == 404


FIXTURE_LIBRARIES = [
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
]


def test_admin_actions_append_to_the_member_history(admin_db):
    a, _ = admin_db
    a.client.find_users_by_email.return_value = []
    a.client.find_user_ids_by_email.return_value = [9]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    a.reissue_invite(a.ReissueInviteBody(email="A@X.com", tier="gold"))
    a.reset_expiry(a.ResetExpiryBody(email="a@x.com", days=35))

    events = a.get_events("a@x.com")
    assert [e["action"] for e in events] == ["Expiry reset", "Invite issued"]  # newest first
    assert "gold tier" in events[1]["detail"]
    assert events[0]["detail"] == "35 days"


def test_notes_roundtrip_and_case_insensitive_email(admin_db):
    a, _ = admin_db
    assert a.get_notes("a@x.com") == {"email": "a@x.com", "notes": ""}
    out = a.save_notes(a.NotesBody(email="A@X.com", notes="prefers 4K remuxes"))
    assert out == {"email": "A@X.com", "notes": "prefers 4K remuxes"}
    assert a.get_notes("a@x.com")["notes"] == "prefers 4K remuxes"


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


def test_reset_expiry_accepts_absolute_datetime(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = [9]
    out = a.reset_expiry(a.ResetExpiryBody(email="a@x.com", expires_at="2026-08-01T00:01:00Z"))
    assert out == {"updated": 1, "expires": "2026-08-01T00:01:00+00:00"}
    a.client.set_expiry.assert_called_once_with(9, "2026-08-01T00:01:00+00:00")
    events = a.get_events("a@x.com")
    assert events[0]["detail"] == "to 2026-08-01T00:01:00+00:00"


def test_reset_expiry_rejects_malformed_expires_at(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = [9]
    with pytest.raises(HTTPException) as e:
        a.reset_expiry(a.ResetExpiryBody(email="a@x.com", expires_at="next tuesday"))
    assert e.value.status_code == 400
    a.client.set_expiry.assert_not_called()


def test_reset_tier_hard_sets_record_and_logs(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    out = a.reset_tier(a.ResetTierBody(email="A@X.com", tier="bronze"))
    assert out == {"email": "A@X.com", "tier": "bronze"}
    assert store.all_customer_tiers(dbp) == {"a@x.com": "bronze"}
    events = a.get_events("a@x.com")
    assert events[0]["action"] == "Tier reset"
    assert events[0]["detail"] == "hard reset to bronze"
    # record-only: no invite, no disable, no Wizarr call at all
    a.client.create_invite.assert_not_called()
    a.client.disable_user.assert_not_called()


@pytest.mark.parametrize("tier", ["bronze", "silver", "gold", "youth"])
def test_reset_tier_hard_sets_each_tier(admin_db, tier):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    out = a.reset_tier(a.ResetTierBody(email="a@x.com", tier=tier))
    assert out == {"email": "a@x.com", "tier": tier}
    assert store.all_customer_tiers(dbp) == {"a@x.com": tier}
    assert a.get_events("a@x.com")[0]["detail"] == f"hard reset to {tier}"


def test_reset_tier_rejects_unknown_tier(admin_db):
    a, dbp = admin_db
    with pytest.raises(HTTPException) as e:
        a.reset_tier(a.ResetTierBody(email="a@x.com", tier="platinum"))
    assert e.value.status_code == 400
    assert store.all_customer_tiers(dbp) == {}


def test_reset_expiry_404_when_no_records(admin_db):
    a, _ = admin_db
    a.client.find_user_ids_by_email.return_value = []
    with pytest.raises(HTTPException) as e:
        a.reset_expiry(a.ResetExpiryBody(email="ghost@x.com", days=15))
    assert e.value.status_code == 404


def test_reissue_invite_keeps_covered_records_enabled(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    # every record sits on a server the new scope covers -> access survives
    a.client.find_users_by_email.return_value = [{"id": 9, "server": "Vermithor"}]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))

    a.client.disable_user.assert_not_called()  # redeeming re-scopes in place
    # private 99. library excluded, non-4k allowed for silver -> ids 17 + 20
    a.client.create_invite.assert_called_once_with(
        [1], 14, "35", library_ids=[17, 20], allow_downloads=False)
    assert out["disabled"] == 0
    assert out["code"] == "xyz"
    assert out["url"] == "http://inv.test/j/xyz"  # public URL, not the LAN one
    assert out["tier"] == "silver"


def test_reissue_invite_disables_all_records_when_a_server_is_uncovered(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    # Caraxes isn't in silver's scope (99. private only) and there's no
    # per-server unshare, so the reissue falls back to disable-first
    a.client.find_users_by_email.return_value = [
        {"id": 9, "server": "Vermithor"},
        {"id": 12, "server": "Caraxes"},
    ]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))

    assert a.client.disable_user.call_count == 2  # all records dropped, not just Caraxes
    # invite must be created BEFORE any disable, so a create failure can't lock
    # the member out with no link to re-redeem
    order = [c[0] for c in a.client.method_calls]
    assert order.index("create_invite") < order.index("disable_user")
    assert out["disabled"] == 2


def test_reissue_invite_emails_the_link(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_users_by_email.return_value = []
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))
    a.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/xyz")
    assert out["emailed"] is True


def test_reissue_invite_survives_email_failure(admin_db):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_users_by_email.return_value = [{"id": 9, "server": "Caraxes"}]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    a.send_invite_email.side_effect = OSError("smtp down")
    out = a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))
    # the reissue itself completed; the admin still gets the link to send manually
    a.client.disable_user.assert_called_once()  # Caraxes uncovered -> disable path
    assert out["emailed"] is False
    assert out["url"] == "http://inv.test/j/xyz"


def test_reissue_invite_keeps_member_visible_as_pending(admin_db):
    a, dbp = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_users_by_email.return_value = [{"id": 9, "server": "Vermithor"}]
    a.client.create_invite.return_value = {"code": "NEW1", "url": "http://wizarr-lan/j/NEW1"}
    a.reissue_invite(a.ReissueInviteBody(email="Code@X.com", tier="gold"))

    # even if Wizarr later drops the records, the store row keeps them listed
    a.client.list_users.return_value = []
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert "code@x.com" in by_email  # still listed while the invite is pending
    assert by_email["code@x.com"]["tier"] == "gold"
    assert by_email["code@x.com"]["subscribed"] is False
    assert by_email["code@x.com"]["invited_at"] is not None  # grace clock started


def test_reissue_invite_fails_closed_without_public_base(admin_db, monkeypatch):
    a, _ = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_users_by_email.return_value = [{"id": 9, "server": "Caraxes"}]
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
    assert "/admin/notes" in paths
    assert "/admin/events" in paths
