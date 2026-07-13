import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# Provide required env before importing the module.
os.environ.update({
    "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "WIZARR_SERVER_ID": "1", "INVITE_EXPIRES_DAYS": "7", "ACCESS_DURATION": "35",
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test", "PUBLIC_INVITE_BASE": "http://inv.test",
    "MAP_DB_PATH": "/tmp/does-not-matter.db",
})


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    import importlib
    import stripe_wizarr_bridge as b
    importlib.reload(b)
    dbp = str(tmp_path / "bridge.db")
    monkeypatch.setattr(b, "MAP_DB_PATH", dbp)
    import store
    store.init_db(dbp)
    b.client = MagicMock()
    monkeypatch.setattr(b, "send_invite_email", MagicMock())
    return b


def test_checkout_creates_invite_and_stores_mapping(bridge):
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://wizarr-lan:5690/j/abc"}
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    bridge.client.create_invite.assert_called_once()
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")
    import store
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["invite_code"] == "abc"


def test_invoice_paid_first_charge_is_skipped(bridge):
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_skip",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_create"}},
    })
    bridge.client.extend_user.assert_not_called()


def test_invoice_paid_renewal_extends(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_id_by_email.return_value = 9
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_cycle",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    bridge.client.extend_user.assert_called_once_with(9, 35)


def test_duplicate_event_is_ignored(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_id_by_email.return_value = 9
    event = {
        "type": "invoice.paid",
        "id": "evt_inv_cycle_dup",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    }
    bridge.handle_event(event)
    bridge.handle_event(event)
    bridge.client.extend_user.assert_called_once_with(9, 35)


def test_subscription_deleted_disables_user(bridge, monkeypatch):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_id_by_email.return_value = 9
    monkeypatch.setattr(bridge, "customer_email", lambda cid: "a@x.com")
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "id": "evt_cancel",
        "data": {"object": {"customer": "cus_1"}},
    })
    bridge.client.disable_user.assert_called_once_with(9)


def test_resolve_prefers_cache_then_email_then_invite(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    # email miss, invite hit -> backfills cache
    bridge.client.find_user_id_by_email.return_value = None
    bridge.client.find_user_id_by_invite.return_value = 7
    uid = bridge.resolve_user_id(bridge.client, bridge.MAP_DB_PATH, "cus_1", "a@x.com")
    assert uid == 7
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["wizarr_user_id"] == 7
