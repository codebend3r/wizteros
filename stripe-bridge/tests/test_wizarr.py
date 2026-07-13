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
