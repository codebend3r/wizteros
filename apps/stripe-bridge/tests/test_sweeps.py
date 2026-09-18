import os
from unittest.mock import MagicMock

import pytest

# Provide required env before importing the module (mailer reads SMTP_* at import).
os.environ.update({
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test",
})

from stripe_bridge import store, sweeps


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "bridge.db")
    store.init_db(path)
    return path


@pytest.fixture
def alert(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr(sweeps, "send_alert_email", mock)
    return mock


def _stripe_subs(monkeypatch, subs):
    listing = MagicMock()
    listing.auto_paging_iter.return_value = subs
    monkeypatch.setattr(sweeps.stripe.Subscription, "list", MagicMock(return_value=listing))


# --- payment states -----------------------------------------------------------


def test_payment_state_check_finds_the_member_the_webhook_never_reported(db, alert, monkeypatch):
    """The sweep is the net under the webhook.

    A member whose payment_failed events never reached the bridge (the event
    type was not enabled on the endpoint for weeks) sat as Subscribed Monthly
    while Stripe declined them three times. Stripe's own subscription status
    is the truth the sweep reads back.
    """
    store.upsert_pending(db, "cus_due", "due@x.com", "abc", tier="bronze")
    store.upsert_pending(db, "cus_ok", "ok@x.com", "def", tier="bronze")
    client = MagicMock()
    client.find_user_ids_by_email.return_value = []
    client.find_user_ids_by_invite.return_value = []
    _stripe_subs(monkeypatch, [
        {"customer": "cus_due", "status": "past_due"},
        {"customer": "cus_ok", "status": "active"},
    ])

    assert sweeps.check_payment_states(client=client, db_path=db) == ["due@x.com"]
    rows = store.all_customer_rows(db)
    assert rows["due@x.com"]["payment_state"] == "past_due"
    assert rows["ok@x.com"]["payment_state"] is None
    assert rows["due@x.com"]["subscribed"] is True  # access is never the sweep's to take
    client.disable_user.assert_not_called()
    alert.assert_called_once()
    subject, body = alert.call_args.args
    assert subject == "1 member(s) missed a payment"
    assert "due@x.com" in body and "NO server access" in body
    assert "ok@x.com" not in body
    actions = [e["action"] for e in store.events_for_email(db, "due@x.com")]
    assert "Payment failed" in actions
    # Writing the flag is what silences the next sweep: no second mail.
    assert sweeps.check_payment_states(client=client, db_path=db) == []
    alert.assert_called_once()


def test_payment_state_check_clears_the_flag_once_stripe_says_active(db, alert, monkeypatch):
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="bronze")
    store.set_payment_state(db, "a@x.com", "past_due")
    _stripe_subs(monkeypatch, [{"customer": "cus_1", "status": "active"}])

    assert sweeps.check_payment_states(client=MagicMock(), db_path=db) == []
    assert store.all_customer_rows(db)["a@x.com"]["payment_state"] is None
    alert.assert_not_called()
    actions = [e["action"] for e in store.events_for_email(db, "a@x.com")]
    assert "Payment recovered" in actions


def test_payment_state_check_reads_the_live_subscription_past_a_dead_one(db, alert, monkeypatch):
    # A member who lapsed and re-subscribed holds a canceled sub next to the
    # live one; the live one is what they are paying.
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="bronze")
    _stripe_subs(monkeypatch, [
        {"customer": "cus_1", "status": "canceled"},
        {"customer": "cus_1", "status": "active"},
    ])
    assert sweeps.check_payment_states(client=MagicMock(), db_path=db) == []
    assert store.all_customer_rows(db)["a@x.com"]["payment_state"] is None


def test_payment_state_check_leaves_unsubscribed_and_unknown_rows_alone(db, alert, monkeypatch):
    store.upsert_pending(db, "cus_gone", "gone@x.com", "abc", tier="bronze")
    store.set_subscribed(db, "gone@x.com", False)
    store.upsert_pending(db, "cus_unlisted", "quiet@x.com", "def", tier="bronze")
    # The canceled member's old sub is past_due in Stripe's history; the other
    # member has no subscription in the listing at all.
    _stripe_subs(monkeypatch, [{"customer": "cus_gone", "status": "past_due"}])

    assert sweeps.check_payment_states(client=MagicMock(), db_path=db) == []
    rows = store.all_customer_rows(db)
    assert rows["gone@x.com"]["payment_state"] is None
    assert rows["quiet@x.com"]["payment_state"] is None
    alert.assert_not_called()


def test_payment_state_check_survives_stripe_being_down(db, alert, monkeypatch):
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="bronze")
    monkeypatch.setattr(sweeps.stripe.Subscription, "list",
                        MagicMock(side_effect=RuntimeError("stripe down")))
    # Unreachable is not a missed payment, and this runs inside the sweep.
    assert sweeps.check_payment_states(client=MagicMock(), db_path=db) == []
    assert store.all_customer_rows(db)["a@x.com"]["payment_state"] is None
    alert.assert_not_called()


# --- vip access ---------------------------------------------------------------


@pytest.fixture
def fresh_sweeps():
    """Reload the module so the last-alerted state starts empty for this test."""
    import importlib
    importlib.reload(sweeps)
    return sweeps


def test_vip_access_check_flags_a_vip_holding_nothing(db, fresh_sweeps, alert):
    """The standing guarantee needs an alarm, not just a guard.

    A VIP can end up with no records for reasons no single guard covers: an
    invite that was never redeemed, a manual disable, a Plex-side unshare. The
    sweep is what turns that silence into a mail.
    """
    store.set_member_tag(db, "vip@x.com", "vip")
    store.set_member_tag(db, "ok@x.com", "vip")
    client = MagicMock()
    client.list_users.return_value = [
        {"id": 1, "email": "ok@x.com", "server": "Meleys", "expires": None},
    ]

    assert sweeps.check_vip_access(client=client, db_path=db) == ["vip@x.com"]
    alert.assert_called_once()
    assert "vip@x.com" in alert.call_args.args[1]
    # A standing problem mails once, not every sweep.
    assert sweeps.check_vip_access(client=client, db_path=db) == ["vip@x.com"]
    alert.assert_called_once()


def test_vip_access_check_is_quiet_when_every_vip_holds_access(db, fresh_sweeps, alert):
    store.set_member_tag(db, "ok@x.com", "vip")
    client = MagicMock()
    client.list_users.return_value = [
        {"id": 1, "email": "ok@x.com", "server": "Meleys", "expires": None},
    ]
    assert sweeps.check_vip_access(client=client, db_path=db) == []
    alert.assert_not_called()


def test_vip_access_check_survives_wizarr_being_down(db, fresh_sweeps, alert):
    store.set_member_tag(db, "vip@x.com", "vip")
    client = MagicMock()
    client.list_users.side_effect = RuntimeError("wizarr down")
    # Unreachable is not the same as locked out, and this runs inside the sweep.
    assert sweeps.check_vip_access(client=client, db_path=db) == []
