import os

from fastapi import APIRouter, Depends, Header, HTTPException

import store
import tiers
from wizarr import WizarrClient

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
router = APIRouter()


def require_admin(x_admin_password: str = Header(default="")) -> None:
    """Reject any admin request whose header doesn't match ADMIN_PASSWORD.

    Fails closed: an unset ADMIN_PASSWORD rejects everything.
    """
    if not ADMIN_PASSWORD or x_admin_password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="unauthorized")


def _dedupe_members(users: list, tier_map: dict) -> list[dict]:
    """Collapse per-server Wizarr records into one entry per person.

    Key is the lowercased email (falling back to username). Aggregates the
    servers a person appears on and keeps the latest expiry across records.
    Tier is joined from the bridge's store; downloads derive from tier.
    """
    people: dict[str, dict] = {}
    for u in users:
        email = (u.get("email") or "").strip()
        username = u.get("username") or ""
        key = (email or username).lower()
        if not key:
            continue
        person = people.setdefault(key, {
            "member": username, "email": email, "servers": [], "expires": None,
        })
        server = u.get("server")
        if server and server not in person["servers"]:
            person["servers"].append(server)
        exp = u.get("expires")
        if exp and (person["expires"] is None or exp > person["expires"]):
            person["expires"] = exp

    members = []
    for person in people.values():
        tier = (tier_map.get(person["email"].lower()) if person["email"] else None) or "unknown"
        downloads = tiers.TIER_DOWNLOADS.get(tier) if tier != "unknown" else None
        members.append({
            "member": person["member"],
            "email": person["email"],
            "tier": tier,
            "downloads": downloads,
            "expires": person["expires"],
            "servers": sorted(person["servers"]),
            "subscribed": person["expires"] is not None,
        })
    members.sort(key=lambda m: m["member"].lower())
    return members


@router.get("/admin/members", dependencies=[Depends(require_admin)])
def list_members() -> list[dict]:
    """One row per person across all servers, with tier + derived downloads."""
    return _dedupe_members(client.list_users(), store.tiers_by_email(MAP_DB_PATH))


@router.get("/admin/member", dependencies=[Depends(require_admin)])
def get_member(email: str) -> dict:
    """The single deduped member matching an email, or 404."""
    matches = _dedupe_members(
        [u for u in client.list_users() if (u.get("email") or "").lower() == email.lower()],
        store.tiers_by_email(MAP_DB_PATH),
    )
    if not matches:
        raise HTTPException(status_code=404, detail="no member for that email")
    return matches[0]
