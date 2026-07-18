import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

import store
import tiers
from wizarr import WizarrClient

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "7"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")
PUBLIC_INVITE_BASE = os.environ.get("PUBLIC_INVITE_BASE", "").rstrip("/")

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


def _member_from_customer(email: str, tier: str | None) -> dict:
    """A table row for a subscriber the bridge knows who hasn't joined Wizarr yet."""
    resolved = tier or "unknown"
    return {
        "member": email.split("@")[0],
        "email": email,
        "tier": resolved,
        "downloads": tiers.TIER_DOWNLOADS.get(resolved) if resolved != "unknown" else None,
        "expires": None,
        "servers": [],
        "subscribed": False,
    }


@router.get("/admin/members", dependencies=[Depends(require_admin)])
def list_members() -> list[dict]:
    """Every member: Wizarr users AND Stripe subscribers who haven't joined yet.

    Wizarr's user list only has people who redeemed an invite, so subscribers
    still holding a pending invite are unioned in from the bridge's customer_map.
    """
    customers = store.all_customer_tiers(MAP_DB_PATH)
    members = _dedupe_members(client.list_users(), customers)
    joined = {m["email"].lower() for m in members if m["email"]}
    pending = [
        _member_from_customer(email, tier)
        for email, tier in customers.items()
        if email not in joined
    ]
    return sorted(members + pending, key=lambda m: m["member"].lower())


@router.get("/admin/member", dependencies=[Depends(require_admin)])
def get_member(email: str) -> dict:
    """A member by email: a Wizarr user, or a Stripe subscriber not yet joined; else 404."""
    customers = store.all_customer_tiers(MAP_DB_PATH)
    matches = _dedupe_members(
        [u for u in client.list_users() if (u.get("email") or "").lower() == email.lower()],
        customers,
    )
    if matches:
        return matches[0]
    if email.lower() in customers:
        return _member_from_customer(email, customers[email.lower()])
    raise HTTPException(status_code=404, detail="no member for that email")


class ResetExpiryBody(BaseModel):
    email: str
    days: int | None


class ReissueInviteBody(BaseModel):
    email: str
    tier: str


@router.post("/admin/reset-expiry", dependencies=[Depends(require_admin)])
def reset_expiry(body: ResetExpiryBody) -> dict:
    """Set (or clear, days=None) the expiry on every record for an email. In-place."""
    ids = client.find_user_ids_by_email(body.email)
    if not ids:
        raise HTTPException(status_code=404, detail="no member for that email")
    expires = None
    if body.days is not None:
        expires = (datetime.now(timezone.utc) + timedelta(days=body.days)).isoformat()
    for uid in ids:
        client.set_expiry(uid, expires)
    return {"updated": len(ids), "expires": expires}


@router.post("/admin/reissue-invite", dependencies=[Depends(require_admin)])
def reissue_invite(body: ReissueInviteBody) -> dict:
    """Issue a fresh tier-scoped invite link, then disable the member's old records.

    Wizarr can't re-scope a member in place, so we re-invite and drop every
    existing record. Scope comes from tiers.resolve_tier_access (fail-closed on
    9X. privates). Returns the public re-join URL.
    """
    if not PUBLIC_INVITE_BASE:
        raise HTTPException(status_code=500, detail="PUBLIC_INVITE_BASE not configured")
    tier = tiers.normalize_tier(body.tier)
    access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
    if not access["library_ids"]:
        raise HTTPException(status_code=502, detail=f"no libraries resolved for tier {tier}")
    ids = client.find_user_ids_by_email(body.email)
    # Create the invite BEFORE disabling: disable_user is account-wide (it severs
    # the plex.tv friendship on every server), so if create_invite raised after
    # the disable loop the member would be locked out with no link to re-redeem.
    invite = client.create_invite(
        access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
        library_ids=access["library_ids"], allow_downloads=access["allow_downloads"],
    )
    # The disable below drops the member's Wizarr records, so without a store
    # row they'd vanish from /admin/members until they redeem the new invite.
    store.upsert_pending_by_email(MAP_DB_PATH, body.email, invite["code"], tier=tier)
    for uid in ids:
        client.disable_user(uid)
    return {
        "url": f"{PUBLIC_INVITE_BASE}/j/{invite['code']}",
        "code": invite["code"],
        "tier": tier,
        "disabled": len(ids),
    }
