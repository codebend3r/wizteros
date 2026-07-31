import importlib
import json
import os
from unittest.mock import MagicMock

import pytest
import requests
import responses

# Env required before importing the module (mirrors test_bridge).
os.environ.update({
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "INVITE_EXPIRES_DAYS": "14", "ACCESS_DURATION": "35",
    "PUBLIC_INVITE_BASE": "http://inv.test",
    "SMTP_HOST": "smtp.test", "SMTP_USER": "u", "SMTP_PASS": "p",
})

from stripe_bridge import admin  # noqa: E402
from stripe_bridge import store  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from stripe_bridge.wizarr import WizarrClient  # noqa: E402

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
    # No plex.tv by default: the members list must be reachable without a token,
    # and tests that exercise the live union opt in explicitly.
    monkeypatch.setattr(admin.plex, "PLEX_TOKEN", "")
    admin.client = MagicMock()
    admin.client.list_users.return_value = USERS
    admin.client.list_libraries.return_value = LIBRARIES
    return admin, dbp


def test_require_admin_rejects_missing_or_malformed_bearer(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a, "_jwks_client", MagicMock())
    monkeypatch.setattr(a, "ADMIN_ALLOWED_EMAILS", {"cj.rivas.dev@gmail.com"})
    for header in ("", "nope", "Basic abc", "Bearer "):
        with pytest.raises(HTTPException) as e:
            a.require_admin(header)
        assert e.value.status_code == 401


def test_require_admin_fails_closed_without_config(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a, "ADMIN_ALLOWED_EMAILS", {"cj.rivas.dev@gmail.com"})
    monkeypatch.setattr(a, "_jwks_client", None)  # JWKS unconfigured -> reject everything
    with pytest.raises(HTTPException) as e:
        a.require_admin("Bearer whatever")
    assert e.value.status_code == 401


def test_require_admin_accepts_allowlisted_supabase_session(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a, "_jwks_client", MagicMock())
    monkeypatch.setattr(a, "ADMIN_ALLOWED_EMAILS", {"cj.rivas.dev@gmail.com"})
    # mixed case in the claim proves the comparison is case-insensitive
    monkeypatch.setattr(a.jwt, "decode", lambda *args, **kwargs: {"email": "CJ.Rivas.dev@gmail.com"})
    assert a.require_admin("Bearer good.token.here") is None


def test_require_admin_rejects_non_allowlisted_email(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a, "_jwks_client", MagicMock())
    monkeypatch.setattr(a, "ADMIN_ALLOWED_EMAILS", {"cj.rivas.dev@gmail.com"})
    monkeypatch.setattr(a.jwt, "decode", lambda *args, **kwargs: {"email": "stranger@example.com"})
    with pytest.raises(HTTPException) as e:
        a.require_admin("Bearer good.token.here")
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


PLEX_SHARES = {
    "a@x.com": {
        "Meleys": {"all_libraries": True, "allow_sync": True,
                   "libraries": ["01. Movies", "05. TV Shows"]},
        "Caraxes": {"all_libraries": False, "allow_sync": False,
                    "libraries": ["09. Basketball"]},
    },
    "nora@x.com": {
        "Syrax": {"all_libraries": False, "allow_sync": False, "libraries": ["02. Anime"]},
    },
}


def test_list_members_unions_the_live_plex_share(admin_db, monkeypatch):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "tok")
    monkeypatch.setattr(a.plex, "shared_access_all", lambda: PLEX_SHARES)
    by_email = {m["email"].lower(): m for m in a.list_members()}

    cj = by_email["a@x.com"]
    # a server only plex.tv knows about is unioned in with Wizarr's records
    assert cj["servers"] == ["Caraxes", "Meleys", "Vhagar"]
    # plex is ground truth where it has an answer...
    assert cj["libraries"]["Meleys"] == ["01. Movies", "05. TV Shows"]
    assert cj["libraries"]["Caraxes"] == ["09. Basketball"]
    # ...and the tier-derived list stands for a server plex didn't report
    assert cj["libraries"]["Vhagar"] == ["03. 4K Movies"]

    # unknown tier derives no libraries, so plex is the only real answer here
    assert by_email["nora@x.com"]["libraries"] == {"Syrax": ["02. Anime"]}


def test_list_members_gives_plex_only_servers_to_a_member_who_never_joined(admin_db, monkeypatch):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="youth")
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "tok")
    monkeypatch.setattr(a.plex, "shared_access_all", lambda: {
        "max@x.com": {"Meleys": {"all_libraries": False, "allow_sync": False,
                                 "libraries": ["03. Family Movies"]}},
    })
    by_email = {m["email"].lower(): m for m in a.list_members()}
    mx = by_email["max@x.com"]
    assert mx["servers"] == ["Meleys"]  # legacy share, no Wizarr record
    assert mx["libraries"] == {"Meleys": ["03. Family Movies"]}


def test_list_members_falls_back_to_tier_access_without_a_plex_token(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    cj = {m["email"].lower(): m for m in a.list_members()}["a@x.com"]
    assert cj["servers"] == ["Meleys", "Vhagar"]
    assert cj["libraries"] == {"Meleys": ["01. Movies"], "Vhagar": ["03. 4K Movies"]}


def test_list_members_survives_a_plex_tv_failure(admin_db, monkeypatch):
    # plex.tv is an enrichment, never a dependency: the table must still load.
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "tok")

    def boom():
        raise requests.ConnectionError("plex.tv down")

    monkeypatch.setattr(a.plex, "shared_access_all", boom)
    cj = {m["email"].lower(): m for m in a.list_members()}["a@x.com"]
    assert cj["servers"] == ["Meleys", "Vhagar"]
    assert cj["libraries"] == {"Meleys": ["01. Movies"], "Vhagar": ["03. 4K Movies"]}


def test_subscribed_is_the_flag_not_the_expiry(admin_db):
    # a@x.com carries a future Wizarr expiry in USERS, but only an admin-issued
    # invite (no confirmed payment). subscribed must be False despite the expiry
    # — this is what lets a member read "Invited" while a 14-day clock counts down.
    a, dbp = admin_db
    store.upsert_pending_by_email(dbp, "a@x.com", "INV1", tier="gold")
    by_email = {m["email"].lower(): m for m in a.list_members()}
    cj = by_email["a@x.com"]
    assert cj["expires"] == "2026-09-10T00:00:00+00:00"  # future expiry present
    assert cj["subscribed"] is False                     # but no payment on record
    assert cj["invited_at"] is not None                  # admin invite stamped it


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
    assert mx["subscribed"] is True   # checkout completed -> confirmed payment
    assert mx["servers"] == []
    assert mx["libraries"] == {}      # not on any server yet
    assert mx["invited_at"] is not None  # upsert stamped the grace clock


def test_get_member_falls_back_to_subscriber(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_max", "max@x.com", "INV1", tier="youth")
    m = a.get_member("max@x.com")
    assert m["email"].lower() == "max@x.com"
    assert m["tier"] == "youth"
    assert m["subscribed"] is True  # checkout completed -> confirmed payment
    with pytest.raises(HTTPException) as missing:
        a.get_member("nobody@nowhere.com")  # in neither Wizarr nor customer_map
    assert missing.value.status_code == 404


def test_member_payloads_carry_the_stripe_customer_id(admin_db):
    """Real cus_ ids surface on both endpoints; admin placeholders never leak."""
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")
    store.upsert_pending_by_email(dbp, "max@x.com", "INV1", tier="youth")

    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert by_email["a@x.com"]["customer_id"] == "cus_1"
    assert by_email["max@x.com"]["customer_id"] is None   # admin:<email> placeholder
    assert by_email["nora@x.com"]["customer_id"] is None  # no customer_map row at all

    assert a.get_member("a@x.com")["customer_id"] == "cus_1"       # joined member
    assert a.get_member("max@x.com")["customer_id"] is None        # pending subscriber


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


@responses.activate
def test_reset_expiry_never_expire_reaches_wizarr_as_an_empty_body(admin_db):
    """Route through the REAL WizarrClient down to the wire.

    The unit tests above mock the client, which is exactly how a
    serialization bug (a literal null Wizarr 400s) once slipped through —
    this pins the actual HTTP body a never-expire produces.
    """
    a, _ = admin_db
    a.client = WizarrClient("http://wizarr.test", "k")
    responses.get("http://wizarr.test/api/users", json={"users": [
        {"id": 9, "username": "cj", "email": "a@x.com", "server": "Meleys"},
    ]})
    responses.put("http://wizarr.test/api/users/9/update-expiry",
                  json={"message": "ok", "new_expiry": None})
    out = a.reset_expiry(a.ResetExpiryBody(email="a@x.com"))
    assert out == {"updated": 1, "expires": None}
    assert json.loads(responses.calls[1].request.body) == {}


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
    from stripe_bridge import stripe_wizarr_bridge as b
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


def _stripe_sub(sub_id: str, cancel_at: int | None = None, flagged: bool = False) -> MagicMock:
    """A minimal Stripe subscription double with explicit (non-Mock) flags."""
    sub = MagicMock()
    sub.id = sub_id
    sub.cancel_at_period_end = flagged
    sub.cancel_at = cancel_at
    return sub


def _stripe_mock_with_subs(subs: list) -> MagicMock:
    s = MagicMock()
    s.Subscription.list.return_value.auto_paging_iter.return_value = subs
    return s


def test_cancel_subscription_flags_subs_for_stored_customer(admin_db, monkeypatch):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_9", "a@x.com", "abc", tier="gold")
    live = _stripe_sub("sub_1")
    stripe_mock = _stripe_mock_with_subs([live])
    stripe_mock.Subscription.modify.return_value = _stripe_sub(
        "sub_1", cancel_at=1790000000, flagged=True)
    monkeypatch.setattr(a, "stripe", stripe_mock)

    result = a.cancel_subscription(a.CancelSubscriptionBody(email="A@X.com"))

    stripe_mock.Subscription.list.assert_called_once_with(customer="cus_9")
    stripe_mock.Subscription.modify.assert_called_once_with(
        "sub_1", cancel_at_period_end=True)
    stripe_mock.Customer.list.assert_not_called()  # mapping wins over email lookup
    assert result["canceled"] == 1
    assert result["cancel_at"].startswith("2026-")
    events = store.events_for_email(dbp, "a@x.com")
    assert events[0]["action"] == "Cancellation scheduled"
    assert "by admin" in events[0]["detail"]


def test_cancel_subscription_falls_back_to_stripe_email_lookup(admin_db, monkeypatch):
    a, _ = admin_db
    stripe_mock = _stripe_mock_with_subs([_stripe_sub("sub_2")])
    customer = MagicMock()
    customer.id = "cus_via_email"
    stripe_mock.Customer.list.return_value.data = [customer]
    stripe_mock.Subscription.modify.return_value = _stripe_sub(
        "sub_2", cancel_at=1790000000, flagged=True)
    monkeypatch.setattr(a, "stripe", stripe_mock)

    result = a.cancel_subscription(a.CancelSubscriptionBody(email="nomap@x.com"))

    stripe_mock.Customer.list.assert_called_once_with(email="nomap@x.com", limit=100)
    stripe_mock.Subscription.list.assert_called_once_with(customer="cus_via_email")
    assert result["canceled"] == 1


def test_cancel_subscription_404s_without_customer_or_subscription(admin_db, monkeypatch):
    a, dbp = admin_db
    stripe_mock = _stripe_mock_with_subs([])
    stripe_mock.Customer.list.return_value.data = []
    monkeypatch.setattr(a, "stripe", stripe_mock)

    with pytest.raises(HTTPException) as no_customer:
        a.cancel_subscription(a.CancelSubscriptionBody(email="ghost@x.com"))
    assert no_customer.value.status_code == 404

    store.upsert_pending(dbp, "cus_idle", "idle@x.com", "abc", tier="gold")
    with pytest.raises(HTTPException) as no_sub:
        a.cancel_subscription(a.CancelSubscriptionBody(email="idle@x.com"))
    assert no_sub.value.status_code == 404


def test_cancel_subscription_is_idempotent_for_already_flagged_subs(admin_db, monkeypatch):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_9", "a@x.com", "abc", tier="gold")
    stripe_mock = _stripe_mock_with_subs(
        [_stripe_sub("sub_1", cancel_at=1790000000, flagged=True)])
    monkeypatch.setattr(a, "stripe", stripe_mock)

    result = a.cancel_subscription(a.CancelSubscriptionBody(email="a@x.com"))

    stripe_mock.Subscription.modify.assert_not_called()
    assert result["canceled"] == 0
    assert result["cancel_at"].startswith("2026-")
    assert store.events_for_email(dbp, "a@x.com") == []  # no duplicate history row


def test_set_tag_roundtrips_through_member_payloads(admin_db):
    a, dbp = admin_db
    a.set_tag(a.SetTagBody(email="A@X.com", tag="vip"))

    assert a.get_member("a@x.com")["tag"] == "vip"
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert by_email["a@x.com"]["tag"] == "vip"
    assert by_email["nora@x.com"]["tag"] is None

    a.set_tag(a.SetTagBody(email="a@x.com", tag=None))
    assert a.get_member("a@x.com")["tag"] is None

    events = store.events_for_email(dbp, "a@x.com")
    assert [e["detail"] for e in events] == ["tag cleared", "tagged VIP"]


def test_set_tag_rejects_unknown_tags(admin_db):
    a, _ = admin_db
    with pytest.raises(HTTPException) as e:
        a.set_tag(a.SetTagBody(email="a@x.com", tag="whale"))
    assert e.value.status_code == 400


def test_set_downloads_overrides_tier_default_in_member_payloads(admin_db):
    a, dbp = admin_db
    store.upsert_pending(dbp, "cus_1", "a@x.com", "abc", tier="gold")  # gold -> downloads True

    a.set_downloads(a.SetDownloadsBody(email="A@X.com", allow=False))

    assert a.get_member("a@x.com")["downloads"] is False  # override beats gold's True
    by_email = {m["email"].lower(): m for m in a.list_members()}
    assert by_email["a@x.com"]["downloads"] is False
    events = store.events_for_email(dbp, "a@x.com")
    assert events[0]["action"] == "Downloads toggled"
    assert events[0]["detail"] == "turned off by admin"

    a.set_downloads(a.SetDownloadsBody(email="a@x.com", allow=True))
    assert a.get_member("a@x.com")["downloads"] is True


def test_reissue_invite_applies_downloads_override(admin_db):
    a, dbp = admin_db
    a.client.list_libraries.return_value = FIXTURE_LIBRARIES
    a.client.find_users_by_email.return_value = [{"id": 9, "server": "Vermithor"}]
    a.client.create_invite.return_value = {"code": "xyz", "url": "http://wizarr-lan/j/xyz"}
    store.set_member_downloads(dbp, "a@x.com", True)

    a.reissue_invite(a.ReissueInviteBody(email="a@x.com", tier="silver"))

    # silver's tier default is allow_downloads=False; the override wins
    kwargs = a.client.create_invite.call_args.kwargs
    assert kwargs["allow_downloads"] is True


def test_plex_access_requires_token(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "")
    with pytest.raises(HTTPException) as no_token:
        a.get_plex_access("a@x.com")
    assert no_token.value.status_code == 503


def test_plex_access_returns_per_server_shares(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "tok")
    monkeypatch.setattr(a.plex, "shared_access_for_email", lambda email: {
        "Meleys": {"all_libraries": True, "allow_sync": True, "libraries": ["01. Movies"]},
    })
    out = a.get_plex_access("a@x.com")
    assert out["email"] == "a@x.com"
    assert out["servers"]["Meleys"]["all_libraries"] is True


def test_plex_access_maps_plex_tv_failure_to_502(admin_db, monkeypatch):
    a, _ = admin_db
    monkeypatch.setattr(a.plex, "PLEX_TOKEN", "tok")

    def boom(email):
        raise requests.ConnectionError("plex.tv down")

    monkeypatch.setattr(a.plex, "shared_access_for_email", boom)
    with pytest.raises(HTTPException) as failed:
        a.get_plex_access("a@x.com")
    assert failed.value.status_code == 502
