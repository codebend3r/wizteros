import logging
import os
from datetime import datetime, timedelta, timezone

import jwt
import requests
import stripe
from fastapi import APIRouter, Depends, Header, HTTPException
from jwt import PyJWKClient
from pydantic import BaseModel

from stripe_bridge import invites, plex, roster, store, tiers
from stripe_bridge.config import MAP_DB_PATH, PUBLIC_INVITE_BASE, client
from stripe_bridge.mailer import send_invite_email
from stripe_bridge.snapshot import UpstreamSnapshot

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

router = APIRouter()


def _fetch_upstream() -> dict:
    """One slow sweep of everything /admin/members needs from Wizarr and plex.tv.

    plex_access is best effort, mirroring roster.with_plex_access: an unset token or
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


def _with_overrides(members: list[dict]) -> list[dict]:
    """Stamp each member dict with the admin overrides the store holds."""
    return roster.with_overrides(members,
                                 tags=store.all_member_tags(MAP_DB_PATH),
                                 downloads=store.all_member_downloads(MAP_DB_PATH))


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
    members = roster.assemble_members(
        users=snap["users"],
        libraries=snap["libraries"],
        invitations=snap.get("invitations") or [],
        customers=store.all_customer_rows(MAP_DB_PATH),
        links=store.all_member_links(MAP_DB_PATH),
    )
    return _with_overrides(
        roster.with_plex_access(members, access=snap["plex_access"]))


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
    members = roster.assemble_members(
        users=users, libraries=libraries, invitations=invitations,
        customers=customers, links=store.all_member_links(MAP_DB_PATH))
    found = next((m for m in members if m["email"].lower() == email.lower()), None)
    # A customer standing as someone else's Stripe address is kept out of the
    # list on purpose, but asking for it by name still has to answer.
    if found is None and email.lower() in customers:
        found = roster.member_from_customer(email, customers[email.lower()], libraries)
    if found is None:
        raise HTTPException(status_code=404, detail="no member for that email")
    return _with_stripe_customer(_with_overrides([found])[0])


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
def get_events(email: str | None = None) -> list[dict]:
    """A member's action history (invites, renewals, cancels), newest first.

    Without an email, the whole log across every member: what the income
    page reads its months and its timeline from.
    """
    if email is None:
        return store.all_events(MAP_DB_PATH)
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


# banned is the one tag with teeth: the bridge refuses to invite, extend or
# restore a banned address, whatever Stripe says about it.
MEMBER_TAGS = ("vip", "hvu", "banned")


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


def _flag_subscriptions(email: str) -> tuple[bool, list, list]:
    """Flag every live Stripe subscription for an email to cancel at period end.

    Returns (a customer exists, newly flagged, already flagged). Customer ids
    come from the bridge's own mapping first, falling back to a live Stripe
    email lookup for members who predate the mapping. Subscriptions already
    flagged are left alone. Nothing here raises for an unknown email or an
    email with no subscription: the caller decides whether that is an error.
    """
    customer_ids = store.customer_ids_for_email(MAP_DB_PATH, email)
    if not customer_ids:
        customer_ids = [c.id for c in stripe.Customer.list(email=email, limit=100).data]
    flagged = []
    already = []
    for customer_id in customer_ids:
        for sub in stripe.Subscription.list(customer=customer_id).auto_paging_iter():
            if getattr(sub, "cancel_at_period_end", False):
                already.append(sub)
            else:
                flagged.append(stripe.Subscription.modify(sub.id, cancel_at_period_end=True))
    return bool(customer_ids), flagged, already


def _cancel_at_of(subscriptions: list) -> str | None:
    """The latest period end among the flagged subscriptions, as an ISO stamp."""
    cancel_ts = max((getattr(sub, "cancel_at", None) or 0 for sub in subscriptions), default=0)
    return datetime.fromtimestamp(cancel_ts, timezone.utc).isoformat() if cancel_ts else None


@router.post("/admin/cancel-subscription", dependencies=[Depends(require_admin)])
def cancel_subscription(body: CancelSubscriptionBody) -> dict:
    """Flag every live Stripe subscription for an email to cancel at period end.

    Mirrors a portal self-cancel: the member keeps access through the period
    they already contributed for, then Stripe fires
    customer.subscription.deleted and the webhook disables their records.
    Nothing is revoked here directly. Idempotent: subscriptions already
    flagged are left alone and still count as scheduled.
    """
    found, flagged, already = _flag_subscriptions(body.email)
    if not found:
        raise HTTPException(status_code=404, detail="no stripe customer for that email")
    if not flagged and not already:
        raise HTTPException(status_code=404, detail="no active subscription for that email")
    cancel_at = _cancel_at_of(flagged + already)
    if flagged:
        store.record_event(
            MAP_DB_PATH, body.email, "Cancellation scheduled",
            f"by admin — access ends {cancel_at[:10]}" if cancel_at else "by admin",
        )
    return {"email": body.email, "canceled": len(flagged), "cancel_at": cancel_at}


class BanBody(BaseModel):
    email: str


@router.post("/admin/ban", dependencies=[Depends(require_admin)])
def ban_member(body: BanBody) -> dict:
    """Revoke a member and mark them so nothing brings them back by accident.

    Three things, in the order that fails safest: the tag first (from here on
    the webhooks refuse to invite, extend or restore this address), then every
    Wizarr record disabled now, then every live Stripe subscription flagged to
    cancel at period end so no further charge lands. Stripe being down costs
    the cancellation, not the ban: the tag and the disable have already
    happened, the event says what was skipped, and the subscription can be
    cancelled by hand. Refunds are a Stripe decision and are never made here.
    Clearing the tag (set-tag with null) lifts the ban; access is re-granted
    only by a fresh invite.
    """
    store.set_member_tag(MAP_DB_PATH, body.email, "banned")
    ids = client.find_user_ids_by_email(body.email)
    for uid in ids:
        client.disable_user(uid)
    try:
        _found, flagged, _already = _flag_subscriptions(body.email)
        cancel_at = _cancel_at_of(flagged)
        billing = (f"billing stops {cancel_at[:10]}" if cancel_at
                   else "no subscription to cancel")
    except Exception:
        log.exception("ban: could not flag subscriptions for %s", body.email)
        flagged, cancel_at = [], None
        billing = "could not reach Stripe, cancel the subscription by hand"
    revoked = (f"{len(ids)} server record(s) disabled" if ids
               else "no server records to disable")
    store.record_event(MAP_DB_PATH, body.email, "Banned", f"{revoked}; {billing}")
    members_snapshot.refresh_async()
    return {"email": body.email, "disabled": len(ids), "canceled": len(flagged),
            "cancel_at": cancel_at}


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
    if store.get_member_tag(MAP_DB_PATH, body.email) == "banned":
        raise HTTPException(status_code=409, detail="member is banned; clear the tag first")
    tier = tiers.normalize_tier(body.tier)
    # Stale cache rows are dropped the same way the checkout path does it: an
    # invite carrying a name Plex no longer knows is rejected whole.
    try:
        access = invites.live_scope(client=client, tier=tier,
                                    context=f"reissue for {body.email}")
    except invites.TierScopeEmpty:
        raise HTTPException(status_code=502, detail=f"no libraries resolved for tier {tier}")
    records = client.find_users_by_email(body.email)
    # The admin's downloads toggle wins over the tier default when set.
    override = store.get_member_downloads(MAP_DB_PATH, body.email)
    # Create the invite BEFORE any disable: disable_user is account-wide (it
    # severs the plex.tv friendship on every server), so if create_invite raised
    # after a disable loop the member would be locked out with no link to redeem.
    invite = invites.mint(client=client, tier=tier, scope=access,
                          allow_downloads=override)
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
