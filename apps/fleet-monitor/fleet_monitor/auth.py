import functools
import os

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient


def _supabase_url() -> str:
    """Base url of the Supabase project that issues admin sessions."""
    return os.environ.get("FM_SUPABASE_URL", "").rstrip("/")


def _allowed_emails() -> frozenset[str]:
    """The admins allowed to read the fleet, lowercased for comparison."""
    raw = os.environ.get("FM_ADMIN_ALLOWED_EMAILS", "")
    return frozenset(part.strip().lower() for part in raw.split(",") if part.strip())


@functools.lru_cache(maxsize=4)
def _jwks_client(url: str) -> PyJWKClient:
    """One key-fetching client per JWKS url, cached across requests.

    Fetching Supabase's public keys is the only network call in this path, and
    PyJWKClient's own cache is what keeps it off it. Read through a function
    rather than built at import so a container that starts before its env is
    complete recovers on the next request instead of staying broken until it
    is restarted.
    """
    return PyJWKClient(url)


def require_admin(authorization: str = Header(default="")) -> None:
    """Reject any fleet read without a valid, allowlisted Supabase session.

    Mirrors the bridge's `require_admin`: the portal sends the signed-in
    admin's access token as `Authorization: Bearer <jwt>`, and this verifies
    the ES256 signature against Supabase's published keys before requiring an
    allowlisted email.

    Fails closed on every path, including unset config. This API answers from
    the public internet through the Funnel now, so a half-configured container
    has to be shut rather than open: what it serves is every host's address,
    container names and utilisation.
    """
    url = _supabase_url()
    allowed = _allowed_emails()
    if not url or not allowed:
        raise HTTPException(status_code=401, detail="unauthorized")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="unauthorized")

    try:
        signing_key = _jwks_client(f"{url}/auth/v1/.well-known/jwks.json").get_signing_key_from_jwt(
            token
        )
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=f"{url}/auth/v1",
        )
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized")

    if str(claims.get("email", "")).lower() not in allowed:
        raise HTTPException(status_code=401, detail="unauthorized")
