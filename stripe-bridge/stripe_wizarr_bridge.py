import logging
import os
import smtplib
from email.message import EmailMessage

import stripe
from fastapi import FastAPI, Header, HTTPException, Request

import store
from wizarr import WizarrClient

STRIPE_API_KEY = os.environ["STRIPE_API_KEY"]
STRIPE_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

WIZARR_BASE_URL = os.environ["WIZARR_BASE_URL"].rstrip("/")
WIZARR_API_KEY = os.environ["WIZARR_API_KEY"]
WIZARR_SERVER_ID = int(os.environ.get("WIZARR_SERVER_ID", "1"))
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

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY, WIZARR_SERVER_ID)
store.init_db(MAP_DB_PATH)

app = FastAPI()


def send_invite_email(to_addr: str, invite_url: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = "Your server access link"
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
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


def customer_email(customer_id: str) -> str | None:
    return stripe.Customer.retrieve(customer_id).get("email")


def resolve_user_id(client, store_path: str, customer_id: str, email: str | None) -> int | None:
    m = store.get_mapping(store_path, customer_id)
    if m and m["wizarr_user_id"]:
        return m["wizarr_user_id"]
    uid = client.find_user_id_by_email(email) if email else None
    if not uid and m and m["invite_code"]:
        uid = client.find_user_id_by_invite(m["invite_code"])
    if uid:
        store.set_user_id(store_path, customer_id, uid)
    return uid


def handle_event(event: dict) -> None:
    etype = event["type"]
    obj = event["data"]["object"]
    log.info("stripe event: %s", etype)

    if etype == "checkout.session.completed":
        email = (obj.get("customer_details") or {}).get("email") or obj.get("customer_email")
        customer_id = obj.get("customer")
        if not email:
            log.warning("no email on session %s", obj.get("id"))
            return
        invite = client.create_invite(INVITE_DAYS, ACCESS_DURATION)
        if customer_id:
            store.upsert_pending(MAP_DB_PATH, customer_id, email, invite["code"])
        send_invite_email(email, invite["url"])
        log.info("sent invite to %s", email)

    elif etype == "invoice.paid":
        if obj.get("billing_reason") == "subscription_create":
            log.info("skipping first (signup) invoice for %s", obj.get("customer"))
            return
        customer_id = obj["customer"]
        email = obj.get("customer_email") or customer_email(customer_id)
        uid = resolve_user_id(client, MAP_DB_PATH, customer_id, email)
        if uid:
            client.extend_user(uid, int(ACCESS_DURATION))
            log.info("extended user %s (+%s days)", uid, ACCESS_DURATION)
        else:
            log.warning("renewal: no wizarr user for %s / %s", customer_id, email)

    elif etype == "customer.subscription.deleted":
        customer_id = obj["customer"]
        email = customer_email(customer_id)
        uid = resolve_user_id(client, MAP_DB_PATH, customer_id, email)
        if uid:
            client.disable_user(uid)
            log.info("disabled user %s (%s)", uid, email)
        else:
            log.info("cancel: no wizarr user for %s / %s", customer_id, email)


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")
    handle_event(event)
    return {"ok": True}
