import logging
import os
import smtplib
from email.message import EmailMessage

import requests
import stripe
from fastapi import FastAPI, Header, HTTPException, Request

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

stripe.api_key = STRIPE_API_KEY
log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

app = FastAPI()


def wizarr_headers():
    return {"X-API-Key": WIZARR_API_KEY, "Content-Type": "application/json"}


def create_invite() -> str:
    r = requests.post(
        f"{WIZARR_BASE_URL}/api/invitations",
        headers=wizarr_headers(),
        json={
            "server_ids": [WIZARR_SERVER_ID],
            "expires_in_days": INVITE_DAYS,
            "duration": ACCESS_DURATION,
            "unlimited": False,
        },
        timeout=10,
    )
    r.raise_for_status()
    code = r.json()["invitation"]["url"].rsplit("/", 1)[-1]
    return f"{PUBLIC_INVITE_BASE}/j/{code}"


def find_wizarr_user_id_by_email(email: str) -> int | None:
    r = requests.get(f"{WIZARR_BASE_URL}/api/users", headers=wizarr_headers(), timeout=10)
    r.raise_for_status()
    for u in r.json().get("users", []):
        if (u.get("email") or "").lower() == email.lower():
            return u["id"]
    return None


def delete_wizarr_user(user_id: int) -> None:
    r = requests.delete(
        f"{WIZARR_BASE_URL}/api/users/{user_id}",
        headers=wizarr_headers(),
        timeout=10,
    )
    r.raise_for_status()


def send_invite_email(to_addr: str, invite_url: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = "Your Plex server access"
    msg["From"] = FROM_ADDR
    msg["To"] = to_addr
    msg.set_content(
        f"""Thanks for contributing to server costs!

Click the link below to set up your Plex account. The invite expires in {INVITE_DAYS} days,
so please complete signup soon.

  {invite_url}

If you cancel your contribution, access will be removed at the end of the current cycle.
""".strip()
    )
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")

    etype = event["type"]
    obj = event["data"]["object"]
    log.info("stripe event: %s", etype)

    if etype == "checkout.session.completed":
        email = obj.get("customer_details", {}).get("email") or obj.get("customer_email")
        if not email:
            log.warning("no email on session %s", obj.get("id"))
            return {"ok": True}
        invite_url = create_invite()
        send_invite_email(email, invite_url)
        log.info("sent invite to %s", email)

    elif etype == "customer.subscription.deleted":
        customer_id = obj["customer"]
        customer = stripe.Customer.retrieve(customer_id)
        email = customer.get("email")
        if not email:
            log.warning("no email for customer %s", customer_id)
            return {"ok": True}
        uid = find_wizarr_user_id_by_email(email)
        if uid:
            delete_wizarr_user(uid)
            log.info("removed wizarr user %s (%s)", uid, email)
        else:
            log.info("no wizarr user found for %s", email)

    return {"ok": True}
