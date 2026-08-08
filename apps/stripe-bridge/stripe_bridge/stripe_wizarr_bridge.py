import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from stripe_bridge import __version__, admin, store, tiers
from stripe_bridge.mailer import send_alert_email, send_invite_email
from stripe_bridge.wizarr import WizarrClient

STRIPE_API_KEY = os.environ["STRIPE_API_KEY"]
STRIPE_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

WIZARR_BASE_URL = os.environ["WIZARR_BASE_URL"].rstrip("/")
WIZARR_API_KEY = os.environ["WIZARR_API_KEY"]
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "14"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")

PUBLIC_INVITE_BASE = os.environ["PUBLIC_INVITE_BASE"].rstrip("/")

MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")
RECONCILE_INTERVAL_SECONDS = int(os.environ.get("RECONCILE_INTERVAL_SECONDS", "3600"))
MEMBERS_SNAPSHOT_INTERVAL_SECONDS = int(
    os.environ.get("MEMBERS_SNAPSHOT_INTERVAL_SECONDS", "300"))

stripe.api_key = STRIPE_API_KEY
log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
store.init_db(MAP_DB_PATH)

# Last set of tier problems alerted on, so a standing breakage mails once
# rather than every sweep. A change in the problem set (or a recovery followed
# by a relapse) alerts again.
_last_tier_problems: dict = {}


def check_tier_scopes() -> dict:
    """Verify every tier still resolves against the live library list; alert on drift.

    The tier rules match Plex library names, so a rename on the server silently
    empties a tier with no code change and no failing test — that is exactly how
    the youth tier died unnoticed. Returns the problems found (empty when
    healthy). Never raises: it runs inside the reconcile loop, and neither a
    down Wizarr nor a down SMTP may take that loop out. A Wizarr that cannot be
    reached is reported as healthy — unreachable is not misconfigured, and the
    next sweep will try again.
    """
    global _last_tier_problems
    try:
        libraries = client.list_libraries()
    except Exception:
        log.exception("tier scope check: could not read libraries from Wizarr")
        return {}
    problems = tiers.tier_scope_problems(libraries=libraries)
    if not problems:
        _last_tier_problems = {}
        return {}
    for tier, reason in problems.items():
        log.error("tier scope check: %s -> %s", tier, reason)
    if problems != _last_tier_problems:
        _last_tier_problems = problems
        body = "\n".join(f"- {tier}: {reason}" for tier, reason in sorted(problems.items()))
        try:
            send_alert_email(
                f"{len(problems)} tier(s) not resolving",
                f"The live Wizarr library list no longer satisfies these tiers:\n\n{body}\n\n"
                f"Members cannot sign up for them until the names line up again.\n",
            )
        except Exception:
            log.exception("tier scope alert email failed")
    return problems


def reconcile_pending_expiries() -> int:
    """Stamp the paid expiry on records that joined without one; returns records stamped.

    Wizarr does not translate an invite's duration into record expiry, so a
    brand-new member redeems into records with no expiry at all — and no
    webhook fires at redemption to correct it. Sweep every subscribed, non-VIP
    member and stamp invited_at + ACCESS_DURATION (the signup date anchors the
    window) on any of their records still unlimited. Records that already
    carry an expiry are never touched, and a computed date already in the past
    is skipped rather than letting a background job revoke access.
    """
    customers = store.all_customer_rows(MAP_DB_PATH)
    tags = store.all_member_tags(MAP_DB_PATH)
    pending = {
        email: row for email, row in customers.items()
        if row["subscribed"] and row["invited_at"] and tags.get(email) != "vip"
    }
    if not pending:
        return 0
    users = client.list_users()
    now = datetime.now(timezone.utc)
    stamped = 0
    for email, row in pending.items():
        records = [u for u in users
                   if (u.get("email") or "").lower() == email and not u.get("expires")]
        if not records:
            continue
        expiry = datetime.fromisoformat(row["invited_at"]) + timedelta(days=int(ACCESS_DURATION))
        if expiry <= now:
            log.warning("reconcile: computed expiry %s for %s is already past; skipping",
                        expiry.isoformat(), email)
            continue
        for u in records:
            client.set_expiry(u["id"], expiry.isoformat())
        stamped += len(records)
        log.info("reconcile: stamped expiry %s on %d record(s) for %s",
                 expiry.isoformat(), len(records), email)
        store.record_event(MAP_DB_PATH, email, "Expiry stamped",
                           f"joined with no expiry — set to {expiry.isoformat()[:10]}")
    return stamped


async def _reconcile_loop() -> None:
    """Run the expiry sweep and the tier scope check now, then every interval.

    The scope check runs first and independently: it is the drift alarm, so it
    must still fire on a sweep where the expiry pass throws.
    """
    while True:
        try:
            await asyncio.to_thread(check_tier_scopes)
        except Exception:
            log.exception("tier scope check failed")
        try:
            await asyncio.to_thread(reconcile_pending_expiries)
        except Exception:
            log.exception("expiry reconcile sweep failed")
        await asyncio.sleep(RECONCILE_INTERVAL_SECONDS)


async def _snapshot_loop() -> None:
    """Warm the members snapshot at boot and keep it fresh thereafter.

    A failed refresh (Wizarr or plex.tv down) logs and retries next interval;
    /admin/members keeps serving the previous snapshot in the meantime.
    """
    while True:
        try:
            await asyncio.to_thread(admin.members_snapshot.refresh)
        except Exception:
            log.exception("members snapshot refresh failed")
        await asyncio.sleep(MEMBERS_SNAPSHOT_INTERVAL_SECONDS)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Keep the reconcile sweep and members-snapshot refresher running for the life of the server."""
    tasks = [asyncio.create_task(_reconcile_loop()), asyncio.create_task(_snapshot_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(lifespan=_lifespan)

ADMIN_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ADMIN_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ADMIN_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
# Bare paths serve Funnel-proxied calls (the /stripe prefix is stripped by
# Funnel); the /stripe-prefixed copy serves direct/local calls, mirroring the
# dual /webhook + /stripe/webhook handlers below.
app.include_router(admin.router)
app.include_router(admin.router, prefix="/stripe")


# Unauthenticated on purpose: the release string is not a secret, and the
# deploy check has to work before anyone holds an admin token. Dual-pathed for
# the same Funnel reason as the webhook handlers below.
@app.get("/stripe/version")
@app.get("/version")
def version():
    """Release version of the running bridge, so a deploy can be verified from outside."""
    return {"version": __version__}


def customer_email(customer_id: str) -> str | None:
    """Email on the Stripe customer record, or None if they have none on file."""
    # retrieve() returns a StripeObject (no dict .get); read the field directly.
    return getattr(stripe.Customer.retrieve(customer_id), "email", None)


def access_expiry_iso() -> str:
    """Absolute expiry for a paid record: the update time plus ACCESS_DURATION."""
    return (datetime.now(timezone.utc) + timedelta(days=int(ACCESS_DURATION))).isoformat()


def resolve_user_ids(client, store_path: str, customer_id: str, email: str | None) -> list[int]:
    """All Wizarr record ids for a member (one per server), resolved live.

    Prefer email; fall back to the stored invite code (Stripe email may differ
    from the Plex account email).
    """
    ids = client.find_user_ids_by_email(email) if email else []
    if not ids:
        m = store.get_mapping(store_path, customer_id)
        if m and m["invite_code"]:
            ids = client.find_user_ids_by_invite(m["invite_code"])
    return ids


def handle_event(event: dict) -> None:
    """Act on one Stripe event: checkout -> invite, renewal -> extend, cancel -> disable.

    Duplicate deliveries (Stripe retries) are dropped via the processed_events
    table. The event is only marked processed after the type-specific handling
    below completes without raising, so a crash mid-handler (e.g. Wizarr
    unreachable, no libraries resolved) leaves the event unmarked and Stripe's
    retry reprocesses it instead of the signup being silently lost.
    """
    event_id = event.get("id")
    if event_id and store.is_event_processed(MAP_DB_PATH, event_id):
        log.info("skipping already-processed event %s", event_id)
        return

    etype = event["type"]
    obj = event["data"]["object"]
    log.info("stripe event: %s", etype)

    _dispatch(etype, obj)

    if event_id:
        store.mark_event_processed(MAP_DB_PATH, event_id)


def _dispatch(etype: str, obj: dict) -> None:
    """Run the type-specific handling for one Stripe event's data object."""
    if etype == "checkout.session.completed":
        email = (obj.get("customer_details") or {}).get("email") or obj.get("customer_email")
        customer_id = obj.get("customer")
        if not email:
            log.warning("no email on session %s", obj.get("id"))
            return
        session_id = obj.get("id")
        tier = tiers.normalize_tier((obj.get("metadata") or {}).get("tier"))
        access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
        if not access["library_ids"]:
            log.error("no libraries resolved for %s tier checkout %s; aborting for retry",
                      tier, session_id)
            raise RuntimeError(f"no libraries resolved for tier {tier!r} on session {session_id!r}")
        # Everything below the invite can raise (a slow Wizarr write, SMTP), and
        # a raise leaves the event unmarked so Stripe retries the whole handler.
        # The session -> invite binding is what stops that retry from minting a
        # second invite and mailing the member a second link.
        issued = store.get_session_invite(MAP_DB_PATH, session_id) if session_id else None
        if issued:
            code = issued["invite_code"]
            log.info("checkout %s already has invite %s; reusing it", session_id, code)
        else:
            code = client.create_invite(
                access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
                library_ids=access["library_ids"],
                allow_downloads=access["allow_downloads"],
            )["code"]
            log.info("created %s invite (%d libraries, servers %s)",
                     tier, len(access["library_ids"]), access["server_ids"])
            if session_id:
                store.record_session_invite(MAP_DB_PATH, session_id, code)
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, code, tier=tier)
        if not (issued and issued["emailed"]):
            send_invite_email(email, f"{PUBLIC_INVITE_BASE}/j/{code}")
            log.info("sent invite to %s", email)
            if session_id:
                store.mark_session_invite_emailed(MAP_DB_PATH, session_id)
            store.record_event(MAP_DB_PATH, email, "Signed up",
                               f"{tier} tier — invite emailed")
        # VIP access is never time-boxed or reshuffled — a VIP's checkout is
        # just a contribution, so their records stay exactly as they are (no
        # disable, no expiry stamp).
        if store.get_member_tag(MAP_DB_PATH, email) == "vip":
            log.info("%s is VIP — existing records left untouched", email)
            return
        # Existing access survives the invite window: redeeming re-scopes the
        # share in place on every covered server. Disable-first only when the
        # new tier leaves a current server uncovered (no per-server unshare),
        # or when the member is only findable via the invite-code fallback
        # (Plex email differs, so coverage can't be evaluated — fail closed).
        records = client.find_users_by_email(email)
        if records:
            existing = tiers.stale_record_ids(
                records=records, covered_servers=access["server_names"])
        else:
            existing = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        for uid in existing:
            client.disable_user(uid)
        if existing:
            log.info("reset %d existing record(s) for %s pending re-join",
                     len(existing), email)
        # Covered records keep access without ever redeeming the new invite,
        # so the purchase itself must stamp the paid expiry — otherwise a
        # shorter pre-signup window (e.g. the 14-day Invited backfill) would
        # survive the checkout.
        disabled = set(existing)
        surviving = [r["id"] for r in records if r["id"] not in disabled]
        expires = access_expiry_iso()
        for uid in surviving:
            client.set_expiry(uid, expires)
        if surviving:
            log.info("stamped expiry %s on %d surviving record(s) for %s",
                     expires, len(surviving), email)

    elif etype == "invoice.paid":
        if obj.get("billing_reason") == "subscription_create":
            log.info("skipping first (signup) invoice for %s", obj.get("customer"))
            return
        customer_id = obj["customer"]
        email = obj.get("customer_email") or customer_email(customer_id)
        if email:
            store.set_subscribed(MAP_DB_PATH, email, True)
        # VIP access is never time-boxed — acknowledge the payment, leave expiry alone.
        if email and store.get_member_tag(MAP_DB_PATH, email) == "vip":
            log.info("renewal: %s is VIP — expiry untouched", email)
            store.record_event(MAP_DB_PATH, email, "Payment received",
                               "VIP — expiry untouched")
            return
        ids = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        expires = access_expiry_iso()
        for uid in ids:
            client.set_expiry(uid, expires)
        if ids:
            log.info("renewed %d record(s) for %s (expires %s)", len(ids), email, expires)
            store.record_event(MAP_DB_PATH, email, "Payment received",
                               f"access extended to {expires[:10]}")
        else:
            log.warning("renewal: no wizarr user for %s / %s", customer_id, email)

    elif etype == "customer.subscription.deleted":
        customer_id = obj["customer"]
        m = store.get_mapping(MAP_DB_PATH, customer_id)
        email = (m and m["email"]) or customer_email(customer_id)
        if email:
            store.set_subscribed(MAP_DB_PATH, email, False)
        ids = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        for uid in ids:
            client.disable_user(uid)
        if ids:
            log.info("disabled %d record(s) for %s", len(ids), email)
        else:
            log.info("cancel: no wizarr user for %s / %s", customer_id, email)
        if email:
            store.record_event(MAP_DB_PATH, email, "Canceled",
                               f"subscription ended — {len(ids)} server record(s) disabled")


# Public URL is /stripe/webhook. Tailscale Funnel mounts the bridge with
# --set-path=/stripe and strips that prefix, so behind Funnel the request
# arrives as /webhook. Accept both paths so direct/local calls (README,
# `stripe listen`) and Funnel-proxied calls hit the same handler.
@app.post("/stripe/webhook")
@app.post("/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    """Verify the Stripe signature, then hand the parsed event to handle_event."""
    payload = await request.body()
    try:
        stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")
    # construct_event returns a StripeObject (no dict .get); the verified raw
    # payload is the same bytes, so decode it into a plain dict for handling.
    handle_event(json.loads(payload))
    return {"ok": True}
