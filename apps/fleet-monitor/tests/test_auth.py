import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from fleet_monitor import api, auth, collector

SUPABASE_URL = "https://project.supabase.co"
ADMIN_EMAIL = "admin@example.com"

# Every route the portal calls. /health is deliberately absent: the container
# healthcheck and the Funnel both probe it without a session.
GATED = ("/fleet", "/fleet/cpu", "/incidents")


@pytest.fixture
def signing_key():
    """One throwaway ES256 keypair standing in for Supabase's.

    Supabase signs session tokens with ES256 and publishes the public half at
    a JWKS url. The test owns both halves so it can mint a token that really
    verifies, rather than asserting against a stubbed-out verifier that would
    still pass if the signature check were removed.
    """
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture
def client(tmp_path, monkeypatch, signing_key):
    db = str(tmp_path / "fleet.db")
    collector.init_db(db)
    monkeypatch.setenv("FM_DB_PATH", db)
    monkeypatch.setenv("FM_SUPABASE_URL", SUPABASE_URL)
    monkeypatch.setenv("FM_ADMIN_ALLOWED_EMAILS", f" {ADMIN_EMAIL.upper()} ,other@example.com")

    # Stand in for the network fetch of Supabase's public keys. The signature
    # is still verified for real against the key this hands back.
    class _Key:
        key = signing_key.public_key()

    class _Jwks:
        def get_signing_key_from_jwt(self, _token):
            return _Key()

    monkeypatch.setattr(auth, "_jwks_client", lambda _url: _Jwks())
    return TestClient(api.app)


def _token(signing_key, *, email=ADMIN_EMAIL, issuer=f"{SUPABASE_URL}/auth/v1", audience="authenticated"):
    return jwt.encode(
        {"email": email, "iss": issuer, "aud": audience},
        signing_key,
        algorithm="ES256",
    )


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.parametrize("path", GATED)
def test_every_portal_route_rejects_an_unauthenticated_read(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("path", GATED)
def test_every_portal_route_serves_an_allowlisted_session(client, signing_key, path):
    assert client.get(path, headers=_bearer(_token(signing_key))).status_code == 200


def test_health_stays_open_so_the_container_probe_needs_no_session(client):
    assert client.get("/health").status_code == 200


def test_a_valid_signature_from_a_stranger_is_still_rejected(client, signing_key):
    token = _token(signing_key, email="stranger@example.com")
    assert client.get("/fleet", headers=_bearer(token)).status_code == 401


def test_an_email_matches_the_allowlist_case_insensitively(client, signing_key):
    token = _token(signing_key, email=ADMIN_EMAIL.upper())
    assert client.get("/fleet", headers=_bearer(token)).status_code == 200


def test_a_token_signed_by_someone_else_is_rejected(client):
    forged = _token(ec.generate_private_key(ec.SECP256R1()))
    assert client.get("/fleet", headers=_bearer(forged)).status_code == 401


def test_a_token_from_another_issuer_is_rejected(client, signing_key):
    token = _token(signing_key, issuer="https://evil.supabase.co/auth/v1")
    assert client.get("/fleet", headers=_bearer(token)).status_code == 401


def test_a_token_for_another_audience_is_rejected(client, signing_key):
    token = _token(signing_key, audience="anon")
    assert client.get("/fleet", headers=_bearer(token)).status_code == 401


@pytest.mark.parametrize("header", ["", "Bearer", "Bearer ", "Basic abc", "token abc"])
def test_a_malformed_authorization_header_is_rejected(client, header):
    assert client.get("/fleet", headers={"Authorization": header}).status_code == 401


# The container is reachable from the public internet through the Funnel, so
# half-configured must mean closed, not open. Both of these used to be the
# difference between "LAN-only" and "published".
def test_an_unset_supabase_url_closes_the_api(client, signing_key, monkeypatch):
    monkeypatch.delenv("FM_SUPABASE_URL")
    assert client.get("/fleet", headers=_bearer(_token(signing_key))).status_code == 401


def test_an_empty_allowlist_closes_the_api(client, signing_key, monkeypatch):
    monkeypatch.setenv("FM_ADMIN_ALLOWED_EMAILS", "  ,  ")
    assert client.get("/fleet", headers=_bearer(_token(signing_key))).status_code == 401


def test_the_preflight_lets_the_portal_send_its_bearer(client):
    """Without `authorization` among the allowed headers the browser never
    sends the real request, and the page reads as a monitor that is down."""
    response = client.options(
        "/fleet",
        headers={
            "Origin": "https://westeroz.netlify.app",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    allowed = response.headers["access-control-allow-headers"].lower()
    assert "authorization" in allowed
