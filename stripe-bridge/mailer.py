"""SMTP invite mail, shared by the Stripe webhook flow and the admin API.

Lives outside stripe_wizarr_bridge so admin.py can send invites without a
circular import (the bridge app imports admin to mount its routes).
"""

import os
import smtplib
from email.message import EmailMessage

from email_template import render_invite_email

SMTP_HOST = os.environ["SMTP_HOST"]
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ["SMTP_USER"]
SMTP_PASS = os.environ["SMTP_PASS"]
FROM_ADDR = os.environ.get("FROM_ADDR", SMTP_USER)
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "7"))


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
