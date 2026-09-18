import logging
import os
from unittest.mock import MagicMock

# Provide required env before importing the module.
os.environ.update({
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test", "ALERT_EMAILS": "ops@test",
})

from stripe_bridge import mailer


def test_alert_email_never_raises(monkeypatch, caplog):
    # Every alert is a copy for the operator, sent from the middle of a flow
    # (a signup, a sweep, a failed charge) that must complete either way.
    # The swallow lives here, once, so no caller has to wrap it.
    monkeypatch.setattr(mailer, "ALERT_ADDRS", ["ops@test"])
    monkeypatch.setattr(mailer.smtplib, "SMTP", MagicMock(side_effect=OSError("smtp down")))
    with caplog.at_level(logging.ERROR, logger="bridge.mailer"):
        mailer.send_alert_email("something broke", "details")
    assert "alert email failed: something broke" in caplog.text


def test_alert_email_is_a_no_op_with_nobody_to_tell(monkeypatch):
    smtp = MagicMock()
    monkeypatch.setattr(mailer, "ALERT_ADDRS", [])
    monkeypatch.setattr(mailer.smtplib, "SMTP", smtp)
    mailer.send_alert_email("something broke", "details")
    smtp.assert_not_called()


def test_alert_email_reaches_every_configured_address(monkeypatch):
    smtp = MagicMock()
    monkeypatch.setattr(mailer, "ALERT_ADDRS", ["a@test", "b@test"])
    monkeypatch.setattr(mailer.smtplib, "SMTP", smtp)
    mailer.send_alert_email("something broke", "details")
    sent = smtp.return_value.__enter__.return_value.send_message.call_args.args[0]
    assert sent["To"] == "a@test, b@test"
    assert sent["Subject"] == "[westeroz] something broke"
