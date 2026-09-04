import logging
import os
import re
from datetime import datetime, timedelta, timezone

import jwt
import requests
import stripe
from fastapi import APIRouter, Depends, Header, HTTPException
from jwt import PyJWKClient
from pydantic import BaseModel

from stripe_bridge import plex, store, tiers
from stripe_bridge.mailer import send_invite_email
from stripe_bridge.snapshot import UpstreamSnapshot
from stripe_bridge.wizarr import WizarrClient

log = logging.getLogger("bridge.admin")

# Admin auth is a Supabase session: the frontend sends the user's access
# token as `Authorization: Bearer <jwt>`. We verify the ES256 signature
# against Supabase's JWKS (public keys), then require an allowlisted email.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ISSUER = f"{SUPABASE_URL}/auth/v1" if SUPABASE_URL else ""
SUPABASE_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
ADMIN_ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("ADMIN_ALLOWED_EMAILS", "").split(",")
    if e.strip()
}

# PyJWKClient fetches and caches the signing keys; created once at import.
_jwks_client = PyJWKClient(SUPABASE_JWKS_URL) if SUPABASE_JWKS_URL else None
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "14"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")
PUBLIC_INVITE_BASE = os.environ.get("PUBLIC_INVITE_BASE", "").rstrip("/")

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
router = APIRouter()


def _fetch_upstream() -> dict:
    """One slow sweep of everything /admin/members needs from Wizarr and plex.tv.

    plex_access is best effort, mirroring _with_plex_access: an unset token or
    a plex.tv failure yields None and the members list falls back to
    tier-derived access rather than failing.
    """
    users = client.list_users()
    libraries = client.list_libraries()
    invitations = client.list_invitations()
    plex_access = None
    if plex.PLEX_TOKEN:
        try:
            plex_access = plex.shared_access_all()
        except requests.RequestException as exc:
            log.error("plex.tv bulk lookup failed; falling back to tier access: %s", exc)
    return {"users": users, "libraries": libraries, "invitations": invitations,
            "plex_access": plex_access}


# Wizarr's users list alone takes ~15s, so /admin/members serves the last
# snapshot instantly; the app's lifespan loop keeps it warm from boot.
members_snapshot = UpstreamSnapshot(fetch=_fetch_upstream)


def require_admin(authorization: str = Header(default="")) -> None:
    """Reject any admin request without a valid, allowlisted Supabase session.

    Fails closed: unset config, a missing/malformed bearer token, a bad
    signature, or a non-allowlisted email all reject.
    """
    if _jwks_client is None or not ADMIN_ALLOWED_EMAILS:
        raise HTTPException(status_code=401, detail="unauthorized")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="unauthorized")

    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            issuer=SUPABASE_ISSUER,
        )
    except Exception:
        raise HTTPException(status_code=401, detail="unauthorized")

    email = str(claims.get("email", "")).lower()
    if email not in ADMIN_ALLOWED_EMAILS:
        raise HTTPException(status_code=401, detail="unauthorized")


# Wizarr marshals an invitation's used_by over a User relationship with no
# __str__, so the live API returns the repr "<User 281>" rather than a name.
_USED_BY_REPR = re.compile(r"\s*<User (\d+)>\s*")


def _plex_email_by_invite(*, invitations: list, users: list) -> dict[str, str]:
    """Invite code -> the Plex account email that redeemed it, both lowercased.

    This is the only link between a Stripe customer and a member who signed up
    to Plex under a different address. The bridge issues the invite against the
    checkout email; whoever redeems it is the person paying, whatever their
    Plex account is called.
    """
    by_id = {u.get("id"): (u.get("email") or "").lower() for u in users}
    by_username = {(u.get("username") or "").lower(): (u.get("email") or "").lower()
                   for u in users}
    resolved: dict[str, str] = {}
    for invitation in invitations:
        code = (invitation.get("code") or "").lower()
        used_by = invitation.get("used_by")
        if not code or not isinstance(used_by, str) or not used_by:
            continue
        match = _USED_BY_REPR.fullmatch(used_by)
        email = (by_id.get(int(match.group(1))) if match
                 else by_username.get(used_by.lower()))
        if email:
            resolved[code] = email
    return resolved


def _customer_by_plex_email(*, customers: dict, plex_email_by_invite: dict,
                            manual_links: dict | None = None) -> dict[str, dict]:
    """Plex email -> the Stripe customer row belonging to that person.

    Only rows whose email differs from the Plex email they resolve to are
    returned: a matching pair needs no linking, and keeping the map to real
    mismatches means the caller can treat a hit as "these are two addresses for
    one person" without re-comparing.

    Two sources, manual first. The redeemed invite answers on its own for
    anyone who signed up through their own checkout. It cannot answer for
    someone who re-subscribed under a re-typed address while already holding
    access: that invite is never redeemed, so `used_by` stays null and the
    paying customer keeps standing as a second member. `member_links` is the
    admin's answer for those, and it is marked so callers can tell a stated
    link from an inferred one.
    """
    linked: dict[str, dict] = {}
    for customer_email, row in customers.items():
        code = (row.get("invite_code") or "").lower()
        manual = (manual_links or {}).get(customer_email)
        plex_email = manual or (plex_email_by_invite.get(code) if code else None)
        if plex_email and plex_email != customer_email:
            linked[plex_email] = {**row, "stripe_email": customer_email,
                                  "manual_link": bool(manual)}
    return linked


def _dedupe_members(users: list, customers: dict, libraries: list,
                    linked: dict | None = None) -> list[dict]:
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
        key = person["email"].lower() if person["email"] else ""
        # Their own address first; the invite linkage only answers for members
        # whose Plex account is under a different email than they pay with.
        # A manual link outranks even that: "they pay under X" is only ever
        # stated about someone whose own address is the dead or failing one,
        # so billing has to read from the customer the admin pointed at.
        link = (linked or {}).get(key) or {}
        row = link if link.get("manual_link") else (customers.get(key) or link or {})
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
            # The tier rules alone, NOT narrowed to the servers this member
            # happens to hold records on — that is what makes it comparable to
            # the live plex.tv share, which is how the member page tells
            # "entitled to" apart from "actually sharing".
            "entitled": tier_libraries,
            "subscribed": bool(row.get("subscribed")),
            "payment_state": row.get("payment_state"),
            "invited_at": row.get("invited_at"),
            "customer_id": row.get("customer_id"),
            # Only set when the member pays under a different address than
            # their Plex account uses. Equal addresses are the norm and would
            # just be the same string twice in the UI.
            "stripe_email": row.get("stripe_email"),
        })
    members.sort(key=lambda m: m["member"].lower())
    return members


def _member_from_customer(email: str, row: dict, libraries: list) -> dict:
    """A table row for a subscriber the bridge knows who hasn't joined Wizarr yet.

    Their tier is known, so `entitled` (what redeeming would grant them) is
    known too and the member page can render a real Servers section instead of
    an empty one. `servers` and `libraries` stay empty on purpose: this member
    holds no Wizarr record, and the only other thing that could give them
    access is a live plex.tv share, which _with_plex_access unions in
    afterwards. Filling them from the tier instead is how a locked-out member
    came to read "1 server, 19 libraries" on /manage while they could not
    watch anything at all.
    """
    resolved = tiers.canonical_tier(row.get("tier")) or "unknown"
    tier_libraries = tiers.tier_server_libraries(tier=resolved, libraries=libraries)
    return {
        "member": email.split("@")[0],
        "email": email,
        "tier": resolved,
        "downloads": tiers.TIER_DOWNLOADS.get(resolved) if resolved != "unknown" else None,
        "expires": None,
        "servers": [],
        "libraries": {},
        "entitled": tier_libraries,
        "subscribed": bool(row.get("subscribed")),
        "payment_state": row.get("payment_state"),
        "invited_at": row.get("invited_at"),
        "customer_id": row.get("customer_id"),
        # Nothing to contrast with: this row IS the Stripe address, and no
        # Plex account has claimed it yet.
        "stripe_email": None,
    }


def _with_plex_access(members: list[dict], *, access: dict | None) -> list[dict]:
    """Union each member's live plex.tv share into their servers and libraries.

    plex.tv is ground truth for what a member can actually see: it covers
    legacy shares that never went through an invite, and members whose tier
    was never recorded (whose tier-derived library list is empty). access is
    the bulk lookup from _fetch_upstream; None (no token, or plex.tv failed)
    leaves the tier-derived values in place rather than failing the whole list.
    """
    if access is None:
        return members
    merged = []
    for member in members:
        shares = access.get(member["email"].lower()) if member["email"] else None
        if not shares:
            merged.append(member)
            continue
        servers = sorted({*member["servers"], *shares})
        merged.append({
            **member,
            "servers": servers,
            "libraries": {
                server: (shares[server]["libraries"] if server in shares
                         else member["libraries"].get(server, []))
                for server in servers
            },
        })
    return merged


def _with_overrides(members: list[dict]) -> list[dict]:
    """Stamp each member dict with its admin overrides.

    tag: the manual designation ("vip"/"hvu"), None untagged. downloads: the
    admin's toggle wins over the tier-derived value when set.
    """
    tags = store.all_member_tags(MAP_DB_PATH)
    downloads = store.all_member_downloads(MAP_DB_PATH)
    return [
        {
            **m,
            "tag": tags.get(m["email"].lower()),
            "downloads": downloads.get(m["email"].lower(), m["downloads"]),
        }
        for m in members
    ]


@router.get("/admin/members", dependencies=[Depends(require_admin)])
def list_members() -> list[dict]:
    """Every member: Wizarr users AND Stripe subscribers who haven't joined yet.

    Wizarr's user list only has people who redeemed an invite, so subscribers
    still holding a pending invite are unioned in from the bridge's customer_map,
    and each row's servers/libraries are reconciled against the live plex.tv share.
    The slow upstream reads come from the warm snapshot (only a cold first call
    pays the full ~15s); tags, downloads, and tier joins stay live from the DB.
    """
    snap = members_snapshot.get()
    customers = store.all_customer_rows(MAP_DB_PATH)
    linked = _customer_by_plex_email(
        customers=customers,
        plex_email_by_invite=_plex_email_by_invite(
            invitations=snap.get("invitations") or [], users=snap["users"]),
        manual_links=store.all_member_links(MAP_DB_PATH),
    )
    members = _dedupe_members(snap["users"], customers, snap["libraries"], linked=linked)
    joined = {m["email"].lower() for m in members if m["email"]}
    # A customer already shown as someone's Stripe address must not also stand
    # as its own row: that is the "two entries for one person" the linkage
    # exists to collapse.
    claimed = {m["stripe_email"] for m in members if m.get("stripe_email")}
    pending = [
        _member_from_customer(email, row, snap["libraries"])
        for email, row in customers.items()
        if email not in joined and email not in claimed
    ]
    return sorted(
        _with_overrides(_with_plex_access(members + pending, access=snap["plex_access"])),
        key=lambda m: m["member"].lower())


def _stripe_customer_id_for(email: str) -> str | None:
    """The member's Stripe customer id, looked up live when the store has none.

    customer_map only holds a real `cus_...` for members the bridge itself put
    there through a checkout. Anyone invited by an admin, or carried over in
    the baseline backfill, gets an "admin:<email>" placeholder instead, and the
    member page then showed no Stripe link at all even when a real customer
    existed at that exact address. Ask Stripe rather than concluding from our
    own row that they never paid.
    """
    try:
        found = stripe.Customer.search(query=f"email:'{email}'", limit=1)
    except Exception:
        log.exception("stripe customer lookup failed for %s", email)
        return None
    data = getattr(found, "data", None) or []
    return data[0]["id"] if data else None


def _with_stripe_customer(member: dict) -> dict:
    """Fill in a missing customer_id from Stripe; leaves a known one alone."""
    if member.get("customer_id") or not member.get("email"):
        return member
    return {**member, "customer_id": _stripe_customer_id_for(member["email"])}


@router.get("/admin/member", dependencies=[Depends(require_admin)])
def get_member(email: str) -> dict:
    """A member by email: a Wizarr user, or a Stripe subscriber not yet joined; else 404."""
    customers = store.all_customer_rows(MAP_DB_PATH)
    libraries = client.list_libraries()
    users = client.list_users()
    # Best effort: a Wizarr that will not list invitations costs the member
    # page its Stripe-email row, not the page itself.
    try:
        invitations = client.list_invitations()
    except Exception:
        log.exception("could not read invitations while resolving %s", email)
        invitations = []
    linked = _customer_by_plex_email(
        customers=customers,
        plex_email_by_invite=_plex_email_by_invite(invitations=invitations, users=users),
        manual_links=store.all_member_links(MAP_DB_PATH),
    )
    matches = _dedupe_members(
        [u for u in users if (u.get("email") or "").lower() == email.lower()],
        customers,
        libraries,
        linked=linked,
    )
    if matches:
        return _with_stripe_customer(_with_overrides(matches)[0])
    if email.lower() in customers:
        return _with_stripe_customer(_with_overrides(
            [_member_from_customer(email, customers[email.lower()], libraries)])[0])
    raise HTTPException(status_code=404, detail="no member for that email")


@router.get("/admin/plex-access", dependencies=[Depends(require_admin)])
def get_plex_access(email: str) -> dict:
    """The email's actual plex.tv share per server — covers uninvited legacy shares too."""
    if not plex.PLEX_TOKEN:
        raise HTTPException(status_code=503, detail="PLEX_TOKEN not configured")
    try:
        return {"email": email, "servers": plex.shared_access_for_email(email)}
    except requests.RequestException as exc:
        log.error("plex.tv lookup failed for %s: %s", email, exc)
        raise HTTPException(status_code=502, detail="plex.tv lookup failed")


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


MEMBER_TAGS = ("vip", "hvu")


class SetTagBody(BaseModel):
    email: str
    tag: str | None = None


@router.post("/admin/set-tag", dependencies=[Depends(require_admin)])
def set_tag(body: SetTagBody) -> dict:
    """Set (or clear, with tag null) the member's manual designation.

    Purely a bridge-side label — Plex access, tier, and expiry are untouched.
    """
    if body.tag is not None and body.tag not in MEMBER_TAGS:
        raise HTTPException(status_code=400, detail=f"unknown tag {body.tag!r}")
    store.set_member_tag(MAP_DB_PATH, body.email, body.tag)
    store.record_event(
        MAP_DB_PATH, body.email, "Tag changed",
        f"tagged {body.tag.upper()}" if body.tag else "tag cleared",
    )
    return {"email": body.email, "tag": body.tag}


class SetDownloadsBody(BaseModel):
    email: str
    allow: bool


@router.post("/admin/set-downloads", dependencies=[Depends(require_admin)])
def set_downloads(body: SetDownloadsBody) -> dict:
    """Toggle the member's allow-downloads override.

    Wizarr has no per-user downloads endpoint, so this can't touch the
    member's current Plex share. The override wins over the tier default on
    every member payload and applies for real on the member's next reissued
    invite.
    """
    store.set_member_downloads(MAP_DB_PATH, body.email, body.allow)
    store.record_event(
        MAP_DB_PATH, body.email, "Downloads toggled",
        f"turned {'on' if body.allow else 'off'} by admin",
    )
    return {"email": body.email, "downloads": body.allow}


class LinkAddressBody(BaseModel):
    stripe_email: str
    plex_email: str | None = None


@router.post("/admin/link-address", dependencies=[Depends(require_admin)])
def link_address(body: LinkAddressBody) -> dict:
    """Declare that `stripe_email` bills for the member watching as `plex_email`.

    The two then read as one member everywhere: one row on the list, the
    paying customer behind it, and a renewal on the Stripe address extending
    the Plex account's records instead of finding nothing and re-inviting.

    Purely a bridge-side statement of identity. No subscription is cancelled,
    no refund is issued, and neither Stripe customer is altered. A member
    paying twice still needs that settled in Stripe. Pass a null `plex_email`
    to undo the link.
    """
    stripe_email = body.stripe_email.strip().lower()
    plex_email = body.plex_email.strip().lower() if body.plex_email else None
    if not stripe_email:
        raise HTTPException(status_code=400, detail="stripe_email is required")
    if plex_email == stripe_email:
        raise HTTPException(status_code=400, detail="an address cannot link to itself")
    # Chains would make "whose row is this" depend on resolution order, and the
    # shape they describe (A pays for B, B pays for C) is not a real one.
    links = store.all_member_links(MAP_DB_PATH)
    if plex_email and plex_email in links:
        raise HTTPException(
            status_code=400,
            detail=f"{plex_email} already pays under {links[plex_email]}; unlink it first")

    store.set_member_link(MAP_DB_PATH, stripe_email=stripe_email, plex_email=plex_email)
    if plex_email:
        store.record_event(MAP_DB_PATH, plex_email, "Address linked",
                           f"pays under {stripe_email}")
        store.record_event(MAP_DB_PATH, stripe_email, "Address linked",
                           f"billing address for {plex_email}")
    else:
        store.record_event(MAP_DB_PATH, stripe_email, "Address unlinked",
                           "stands as its own member again")
    return {"stripe_email": stripe_email, "plex_email": plex_email}


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
    members_snapshot.refresh_async()
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
    # Stale cache rows are dropped the same way the checkout path does it: an
    # invite carrying a name Plex no longer knows is rejected whole.
    libraries = tiers.without_stale(
        libraries=client.list_libraries(), live=plex.live_sections_or_none())
    access = tiers.resolve_tier_access(tier=tier, libraries=libraries)
    if not access["library_ids"]:
        raise HTTPException(status_code=502, detail=f"no libraries resolved for tier {tier}")
    records = client.find_users_by_email(body.email)
    # The admin's downloads toggle wins over the tier default when set.
    override = store.get_member_downloads(MAP_DB_PATH, body.email)
    allow_downloads = access["allow_downloads"] if override is None else override
    # Create the invite BEFORE any disable: disable_user is account-wide (it
    # severs the plex.tv friendship on every server), so if create_invite raised
    # after a disable loop the member would be locked out with no link to redeem.
    invite = client.create_invite(
        access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
        library_ids=access["library_ids"], allow_downloads=allow_downloads,
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
    members_snapshot.refresh_async()
    return {
        "url": url,
        "code": invite["code"],
        "tier": tier,
        "disabled": len(stale),
        "emailed": emailed,
    }
