import logging
import os
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

import store
import tiers
from mailer import send_invite_email
from wizarr import WizarrClient

log = logging.getLogger("bridge.admin")

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "14"))
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


def _dedupe_members(users: list, customers: dict, libraries: list) -> list[dict]:
    """Collapse per-server Wizarr records into one entry per person.

    Key is the lowercased email (falling back to username). Aggregates the
    servers a person appears on and keeps the latest expiry across records.
    Tier and invited_at are joined from the bridge's store; downloads and
    per-server library access derive from tier.
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
        row = (customers.get(person["email"].lower()) if person["email"] else None) or {}
        tier = tiers.canonical_tier(row.get("tier")) or "unknown"
        downloads = tiers.TIER_DOWNLOADS.get(tier) if tier != "unknown" else None
        servers = sorted(person["servers"])
        tier_libraries = tiers.tier_server_libraries(tier=tier, libraries=libraries)
        members.append({
            "member": person["member"],
            "email": person["email"],
            "tier": tier,
            "downloads": downloads,
            "expires": person["expires"],
            "servers": servers,
            "libraries": {server: tier_libraries.get(server, []) for server in servers},
            "subscribed": person["expires"] is not None,
            "invited_at": row.get("invited_at"),
        })
    members.sort(key=lambda m: m["member"].lower())
    return members


def _member_from_customer(email: str, row: dict) -> dict:
    """A table row for a subscriber the bridge knows who hasn't joined Wizarr yet."""
    resolved = tiers.canonical_tier(row.get("tier")) or "unknown"
    return {
        "member": email.split("@")[0],
        "email": email,
        "tier": resolved,
        "downloads": tiers.TIER_DOWNLOADS.get(resolved) if resolved != "unknown" else None,
        "expires": None,
        "servers": [],
        "libraries": {},
        "subscribed": False,
        "invited_at": row.get("invited_at"),
    }


@router.get("/admin/members", dependencies=[Depends(require_admin)])
def list_members() -> list[dict]:
    """Every member: Wizarr users AND Stripe subscribers who haven't joined yet.

    Wizarr's user list only has people who redeemed an invite, so subscribers
    still holding a pending invite are unioned in from the bridge's customer_map.
    """
    customers = store.all_customer_rows(MAP_DB_PATH)
    members = _dedupe_members(client.list_users(), customers, client.list_libraries())
    joined = {m["email"].lower() for m in members if m["email"]}
    pending = [
        _member_from_customer(email, row)
        for email, row in customers.items()
        if email not in joined
    ]
    return sorted(members + pending, key=lambda m: m["member"].lower())


@router.get("/admin/member", dependencies=[Depends(require_admin)])
def get_member(email: str) -> dict:
    """A member by email: a Wizarr user, or a Stripe subscriber not yet joined; else 404."""
    customers = store.all_customer_rows(MAP_DB_PATH)
    matches = _dedupe_members(
        [u for u in client.list_users() if (u.get("email") or "").lower() == email.lower()],
        customers,
        client.list_libraries(),
    )
    if matches:
        return matches[0]
    if email.lower() in customers:
        return _member_from_customer(email, customers[email.lower()])
    raise HTTPException(status_code=404, detail="no member for that email")


@router.get("/admin/events", dependencies=[Depends(require_admin)])
def get_events(email: str) -> list[dict]:
    """The member's action history (invites, renewals, cancels), newest first."""
    return store.events_for_email(MAP_DB_PATH, email)


@router.get("/admin/notes", dependencies=[Depends(require_admin)])
def get_notes(email: str) -> dict:
    """The admin's notes for an email; empty when none have been saved yet."""
    return {"email": email, "notes": store.get_member_notes(MAP_DB_PATH, email)}


class NotesBody(BaseModel):
    email: str
    notes: str


@router.post("/admin/notes", dependencies=[Depends(require_admin)])
def save_notes(body: NotesBody) -> dict:
    """Save (overwrite) the admin's notes for an email."""
    store.set_member_notes(MAP_DB_PATH, body.email, body.notes)
    return {"email": body.email, "notes": body.notes}


class ResetExpiryBody(BaseModel):
    email: str
    days: int | None = None
    expires_at: str | None = None


class ResetTierBody(BaseModel):
    email: str
    tier: str


class ReissueInviteBody(BaseModel):
    email: str
    tier: str


class CancelSubscriptionBody(BaseModel):
    email: str


@router.post("/admin/cancel-subscription", dependencies=[Depends(require_admin)])
def cancel_subscription(body: CancelSubscriptionBody) -> dict:
    """Flag every live Stripe subscription for an email to cancel at period end.

    Mirrors a portal self-cancel: the member keeps access through the period
    they already contributed for, then Stripe fires
    customer.subscription.deleted and the webhook disables their records —
    nothing is revoked here directly. Customer ids come from the bridge's own
    mapping first, falling back to a live Stripe email lookup for members who
    predate the mapping. Idempotent: subscriptions already flagged are left
    alone and still count as scheduled.
    """
    customer_ids = store.customer_ids_for_email(MAP_DB_PATH, body.email)
    if not customer_ids:
        customer_ids = [c.id for c in stripe.Customer.list(email=body.email, limit=100).data]
    if not customer_ids:
        raise HTTPException(status_code=404, detail="no stripe customer for that email")
    flagged = []
    already = []
    for customer_id in customer_ids:
        for sub in stripe.Subscription.list(customer=customer_id).auto_paging_iter():
            if getattr(sub, "cancel_at_period_end", False):
                already.append(sub)
            else:
                flagged.append(stripe.Subscription.modify(sub.id, cancel_at_period_end=True))
    if not flagged and not already:
        raise HTTPException(status_code=404, detail="no active subscription for that email")
    cancel_ts = max(
        (getattr(sub, "cancel_at", None) or 0 for sub in flagged + already), default=0)
    cancel_at = (
        datetime.fromtimestamp(cancel_ts, timezone.utc).isoformat() if cancel_ts else None
    )
    if flagged:
        store.record_event(
            MAP_DB_PATH, body.email, "Cancellation scheduled",
            f"by admin — access ends {cancel_at[:10]}" if cancel_at else "by admin",
        )
    return {"email": body.email, "canceled": len(flagged), "cancel_at": cancel_at}


@router.post("/admin/reset-expiry", dependencies=[Depends(require_admin)])
def reset_expiry(body: ResetExpiryBody) -> dict:
    """Set (or clear) the expiry on every record for an email. In-place.

    expires_at (an absolute ISO datetime) wins over days; with neither set the
    expiry is cleared.
    """
    ids = client.find_user_ids_by_email(body.email)
    if not ids:
        raise HTTPException(status_code=404, detail="no member for that email")
    if body.expires_at is not None:
        try:
            parsed = datetime.fromisoformat(body.expires_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="expires_at is not an ISO datetime")
        expires = parsed.isoformat()
        detail = f"to {expires}"
    elif body.days is not None:
        expires = (datetime.now(timezone.utc) + timedelta(days=body.days)).isoformat()
        detail = f"{body.days} days"
    else:
        expires = None
        detail = "cleared"
    for uid in ids:
        client.set_expiry(uid, expires)
    store.record_event(MAP_DB_PATH, body.email, "Expiry reset", detail)
    return {"updated": len(ids), "expires": expires}


@router.post("/admin/reset-tier", dependencies=[Depends(require_admin)])
def reset_tier(body: ResetTierBody) -> dict:
    """Hard-set the member's recorded tier in place — no re-invite, no disable.

    Only rewrites the bridge's record (which drives the displayed tier,
    downloads, and library derivation); the member's actual Plex shares are
    untouched. Use reissue-invite when access itself must change.
    """
    if body.tier not in tiers.TIER_DOWNLOADS:
        raise HTTPException(status_code=400, detail=f"unknown tier {body.tier!r}")
    store.set_tier(MAP_DB_PATH, body.email, body.tier)
    store.record_event(MAP_DB_PATH, body.email, "Tier reset", f"hard reset to {body.tier}")
    return {"email": body.email, "tier": body.tier}


@router.post("/admin/reissue-invite", dependencies=[Depends(require_admin)])
def reissue_invite(body: ReissueInviteBody) -> dict:
    """Issue a fresh tier-scoped invite link; existing access survives the wait.

    Redeeming the invite re-scopes the member's share in place on every server
    the invite covers (Wizarr updates the sections for an already-shared
    account), so nothing is disabled up front and the member keeps their
    current access until they join through the link. The one exception is a
    tier that leaves a current server uncovered — Wizarr has no per-server
    unshare, so that reissue falls back to disable-first (with the access gap).
    Scope comes from tiers.resolve_tier_access (fail-closed on 9X. privates).
    Returns the public re-join URL.
    """
    if not PUBLIC_INVITE_BASE:
        raise HTTPException(status_code=500, detail="PUBLIC_INVITE_BASE not configured")
    tier = tiers.normalize_tier(body.tier)
    access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
    if not access["library_ids"]:
        raise HTTPException(status_code=502, detail=f"no libraries resolved for tier {tier}")
    records = client.find_users_by_email(body.email)
    # Create the invite BEFORE any disable: disable_user is account-wide (it
    # severs the plex.tv friendship on every server), so if create_invite raised
    # after a disable loop the member would be locked out with no link to redeem.
    invite = client.create_invite(
        access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
        library_ids=access["library_ids"], allow_downloads=access["allow_downloads"],
    )
    # The store row keeps the member on /admin/members while the invite is
    # pending and stamps invited_at for the grace-period status.
    store.upsert_pending_by_email(MAP_DB_PATH, body.email, invite["code"], tier=tier)
    stale = tiers.stale_record_ids(records=records, covered_servers=access["server_names"])
    for uid in stale:
        client.disable_user(uid)
    url = f"{PUBLIC_INVITE_BASE}/j/{invite['code']}"
    # An SMTP failure must not fail the reissue (it already happened); report
    # it so the admin sends the link manually instead of re-inviting.
    emailed = True
    try:
        send_invite_email(body.email, url)
    except Exception:
        log.exception("invite email to %s failed", body.email)
        emailed = False
    store.record_event(
        MAP_DB_PATH, body.email, "Invite issued",
        f"{tier} tier — " + ("link emailed" if emailed else "email failed, link sent manually"),
    )
    return {
        "url": url,
        "code": invite["code"],
        "tier": tier,
        "disabled": len(stale),
        "emailed": emailed,
    }
