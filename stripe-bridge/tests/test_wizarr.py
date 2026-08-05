import json

import pytest
import requests
import responses
from stripe_bridge.wizarr import WizarrClient

BASE = "http://wizarr.test"


def client():
    """Fresh WizarrClient pointed at the fake base URL."""
    return WizarrClient(BASE, "key")


@responses.activate
def test_create_invite_scopes_libraries_and_downloads():
    responses.post(
        f"{BASE}/api/invitations",
        json={"invitation": {"id": 5, "code": "abc123",
                             "url": f"{BASE}/j/abc123"}},
        status=201,
    )
    out = client().create_invite([1, 2], expires_in_days=7, duration="35",
                                 library_ids=[17, 20], allow_downloads=True)
    assert out == {"code": "abc123", "url": f"{BASE}/j/abc123"}
    sent = json.loads(responses.calls[0].request.body)
    assert sent["server_ids"] == [1, 2]
    assert sent["expires_in_days"] == 7
    assert sent["duration"] == "35"
    assert sent["unlimited"] is False
    assert sent["library_ids"] == [17, 20]
    assert sent["allow_downloads"] is True


@responses.activate
def test_create_invite_omits_library_ids_when_unscoped():
    responses.post(
        f"{BASE}/api/invitations",
        json={"invitation": {"id": 6, "code": "def456",
                             "url": f"{BASE}/j/def456"}},
        status=201,
    )
    client().create_invite([1], expires_in_days=7, duration="35")
    sent = json.loads(responses.calls[0].request.body)
    assert "library_ids" not in sent
    assert sent["allow_downloads"] is False


@responses.activate
def test_list_libraries_returns_raw_library_dicts():
    responses.get(
        f"{BASE}/api/libraries",
        json={"libraries": [
            {"id": 17, "name": "01. TV Shows", "server_id": 1,
             "server_name": "Vermithor", "enabled": True},
            {"id": 37, "name": "99. Tutorials", "server_id": 4,
             "server_name": "Caraxes", "enabled": True},
        ]},
    )
    libs = client().list_libraries()
    assert [lib["id"] for lib in libs] == [17, 37]
    assert libs[0]["server_name"] == "Vermithor"


@responses.activate
def test_find_user_ids_by_email_returns_all_matching_records():
    # One email maps to one record per server; return every matching id.
    responses.get(f"{BASE}/api/users",
                  json={"users": [
                      {"id": 9, "username": "cj", "email": "a@x.com", "server": "Meleys"},
                      {"id": 12, "username": "cj", "email": "a@x.com", "server": "Vhagar"},
                      {"id": 3, "username": "other", "email": "other@x.com", "server": "Meleys"},
                  ]})
    assert client().find_user_ids_by_email("a@x.com") == [9, 12]

    responses.reset()
    responses.get(f"{BASE}/api/users", json={"users": []})
    assert client().find_user_ids_by_email("nope@x.com") == []


@responses.activate
def test_find_user_ids_by_invite_walks_used_by_returns_all():
    responses.get(f"{BASE}/api/invitations",
                  json={"invitations": [{"code": "abc123", "used_by": "cj"}]})
    responses.get(f"{BASE}/api/users",
                  json={"users": [
                      {"id": 9, "username": "cj", "email": "a@x.com", "server": "Meleys"},
                      {"id": 12, "username": "cj", "email": "a@x.com", "server": "Vhagar"},
                  ]})
    assert client().find_user_ids_by_invite("abc123") == [9, 12]

    responses.reset()
    responses.get(f"{BASE}/api/invitations",
                  json={"invitations": [{"code": "abc123", "used_by": None}]})
    assert client().find_user_ids_by_invite("abc123") == []


@responses.activate
def test_find_user_ids_by_email_matches_case_insensitively_and_skips_null_emails():
    # Stripe and Plex emails can differ in case; Wizarr records can lack one.
    responses.get(f"{BASE}/api/users",
                  json={"users": [
                      {"id": 9, "username": "cj", "email": "A@X.com", "server": "Meleys"},
                      {"id": 12, "username": "local", "email": None, "server": "Vhagar"},
                  ]})
    assert client().find_user_ids_by_email("a@x.com") == [9]


@responses.activate
def test_wizarr_http_errors_propagate():
    responses.get(f"{BASE}/api/libraries", json={"error": "boom"}, status=500)
    with pytest.raises(requests.HTTPError):
        client().list_libraries()


@responses.activate
def test_set_expiry_and_disable_call_correct_paths():
    responses.put(f"{BASE}/api/users/9/update-expiry",
                  json={"message": "ok", "new_expiry": "2026-08-17T00:00:00+00:00"})
    responses.post(f"{BASE}/api/users/9/disable", json={"message": "ok"})
    client().set_expiry(9, "2026-08-17T00:00:00+00:00")
    client().disable_user(9)
    assert responses.calls[0].request.url == f"{BASE}/api/users/9/update-expiry"
    assert json.loads(responses.calls[0].request.body)["expires"] == "2026-08-17T00:00:00+00:00"
    assert responses.calls[1].request.url == f"{BASE}/api/users/9/disable"


@responses.activate
def test_set_expiry_clears_by_omitting_the_expires_key():
    # Wizarr validates the request body against its schema (expires must be a
    # date-time string), so a literal null is rejected with a 400. Clearing to
    # unlimited works by omitting the key entirely.
    responses.put(f"{BASE}/api/users/9/update-expiry",
                  json={"message": "ok", "new_expiry": None})
    client().set_expiry(9, None)
    assert json.loads(responses.calls[0].request.body) == {}


@responses.activate
def test_list_users_returns_all_records():
    responses.get(f"{BASE}/api/users", json={"users": [
        {"id": 9, "username": "cj", "email": "a@x.com", "server": "Meleys", "expires": None},
        {"id": 12, "username": "cj", "email": "a@x.com", "server": "Vhagar", "expires": None},
    ]})
    out = client().list_users()
    assert [u["id"] for u in out] == [9, 12]


@responses.activate
def test_user_writes_allow_for_a_slow_wizarr():
    # /api/users/<id>/disable and update-expiry go through the same slow Plex
    # reconcile as /api/users; a 10s ceiling timed out mid-disable in prod and
    # left a checkout half-applied.
    responses.post(f"{BASE}/api/users/7/disable", json={})
    responses.put(f"{BASE}/api/users/7/update-expiry", json={})
    c = client()
    c.disable_user(7)
    c.set_expiry(7, "2026-09-09T00:00:00+00:00")
    assert responses.calls[0].request.req_kwargs["timeout"] >= 45
    assert responses.calls[1].request.req_kwargs["timeout"] >= 45
