"""SMTP invite mail, shared by the Stripe webhook flow and the admin API.

Lives outside stripe_wizarr_bridge so admin.py can send invites without a
circular import (the bridge app imports admin to mount its routes).
"""

import os
import smtplib
from email.message import EmailMessage

from stripe_bridge.email_template import render_invite_email

SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASS = os.environ["SMTP_PASS"]
FROM_ADDR = os.environ.get("FROM_ADDR", SMTP_USER)
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "14"))
# Where operational alerts go. Falls back to the admin allowlist so a fresh
# deploy still reaches someone without another env var to remember.
ALERT_ADDRS = [
    a.strip() for a in
    (os.environ.get("ALERT_EMAILS") or os.environ.get("ADMIN_ALLOWED_EMAILS", "")).split(",")
    if a.strip()
]


def send_alert_email(subject: str, body: str) -> None:
    """Mail an operational alert to the admins; no-op when no address is configured.

    Plain text on purpose — these are for the operator, not members, and must
    stay readable in any client and quotable into an incident note.
    """
    if not ALERT_ADDRS:
        return
    msg = EmailMessage()
    msg["Subject"] = f"[westeroz] {subject}"
    msg["From"] = FROM_ADDR
    msg["To"] = ", ".join(ALERT_ADDRS)
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


def send_invite_email(to_addr: str, invite_url: str) -> None:
    """Compose the invite email (plain text + styled HTML) and send it over SMTP with STARTTLS."""
    msg = EmailMessage()
    msg["Subject"] = "Your Westeroz access link"
    msg["From"] = FROM_ADDR
    msg["To"] = to_addr
    msg.set_content(
        f"""Thanks for contributing to server costs!

Click the link below to set up your account. You'll sign in with a Plex account;
if you don't have one yet, create it with this same email address so your access
stays linked to your contribution.

The invite expires in {INVITE_DAYS} days, so please complete signup soon.

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
