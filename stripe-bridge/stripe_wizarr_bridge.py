import json
import logging
import os
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import stripe
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

import admin
import store
import tiers
from email_template import render_invite_email
from wizarr import WizarrClient

STRIPE_API_KEY = os.environ["STRIPE_API_KEY"]
STRIPE_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

WIZARR_BASE_URL = os.environ["WIZARR_BASE_URL"].rstrip("/")
WIZARR_API_KEY = os.environ["WIZARR_API_KEY"]
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "7"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")

SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASS = os.environ["SMTP_PASS"]
FROM_ADDR = os.environ.get("FROM_ADDR", SMTP_USER)
PUBLIC_INVITE_BASE = os.environ["PUBLIC_INVITE_BASE"].rstrip("/")

MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")

stripe.api_key = STRIPE_API_KEY
log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
store.init_db(MAP_DB_PATH)

app = FastAPI()

ADMIN_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ADMIN_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ADMIN_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["X-Admin-Password", "Content-Type"],
)
# Bare paths serve Funnel-proxied calls (the /stripe prefix is stripped by
# Funnel); the /stripe-prefixed copy serves direct/local calls, mirroring the
# dual /webhook + /stripe/webhook handlers below.
app.include_router(admin.router)
app.include_router(admin.router, prefix="/stripe")


def send_invite_email(to_addr: str, invite_url: str) -> None:
    """Compose the invite email (plain text + styled HTML) and send it over SMTP with STARTTLS."""
    msg = EmailMessage()
    msg["Subject"] = "Your Westeroz access link"
    msg["From"] = FROM_ADDR
    msg["To"] = to_addr
    msg.set_content(
        f"""Thanks for contributing to server costs!

Click the link below to set up your account. The invite expires in {INVITE_DAYS} days,
so please complete signup soon.

  {invite_url}

If you cancel your contribution, access will be removed at the end of the current cycle.
""".strip()
    )
    msg.add_alternative(
        render_invite_email(invite_url=invite_url, expires_days=INVITE_DAYS),
        subtype="html",
    )
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


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
        tier = tiers.normalize_tier((obj.get("metadata") or {}).get("tier"))
        access = tiers.resolve_tier_access(tier=tier, libraries=client.list_libraries())
        if not access["library_ids"]:
            log.error("no libraries resolved for %s tier checkout %s; aborting for retry",
                      tier, obj.get("id"))
            raise RuntimeError(f"no libraries resolved for tier {tier!r} on session {obj.get('id')!r}")
        invite = client.create_invite(
            access["server_ids"], INVITE_DAYS, ACCESS_DURATION,
            library_ids=access["library_ids"],
            allow_downloads=access["allow_downloads"],
        )
        log.info("created %s invite (%d libraries, servers %s)",
                 tier, len(access["library_ids"]), access["server_ids"])
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, invite["code"], tier=tier)
        invite_url = f"{PUBLIC_INVITE_BASE}/j/{invite['code']}"
        send_invite_email(email, invite_url)
        log.info("sent invite to %s", email)
        # Reset-and-rejoin: Wizarr can't scope an existing member's shares per
        # server (disable severs the whole plex.tv friendship), so drop every
        # existing record; redeeming the invite re-grants exactly the tier's
        # access with the invite's duration.
        existing = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        for uid in existing:
            client.disable_user(uid)
        if existing:
            log.info("reset %d existing record(s) for %s pending re-join",
                     len(existing), email)

    elif etype == "invoice.paid":
        if obj.get("billing_reason") == "subscription_create":
            log.info("skipping first (signup) invoice for %s", obj.get("customer"))
            return
        customer_id = obj["customer"]
        email = obj.get("customer_email") or customer_email(customer_id)
        ids = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        expires = access_expiry_iso()
        for uid in ids:
            client.set_expiry(uid, expires)
        if ids:
            log.info("renewed %d record(s) for %s (expires %s)", len(ids), email, expires)
        else:
            log.warning("renewal: no wizarr user for %s / %s", customer_id, email)

    elif etype == "customer.subscription.deleted":
        customer_id = obj["customer"]
        m = store.get_mapping(MAP_DB_PATH, customer_id)
        email = (m and m["email"]) or customer_email(customer_id)
        ids = resolve_user_ids(client, MAP_DB_PATH, customer_id, email)
        for uid in ids:
            client.disable_user(uid)
        if ids:
            log.info("disabled %d record(s) for %s", len(ids), email)
        else:
            log.info("cancel: no wizarr user for %s / %s", customer_id, email)


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
