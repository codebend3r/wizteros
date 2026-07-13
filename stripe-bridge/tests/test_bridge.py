import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# Provide required env before importing the module.
os.environ.update({
    "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "WIZARR_SERVER_IDS": "all", "INVITE_EXPIRES_DAYS": "7", "ACCESS_DURATION": "35",
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


def test_checkout_brand_new_member_invites_without_time_boxing(bridge):
    bridge.client.list_server_ids.return_value = [1, 2, 3, 4, 5]
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://wizarr-lan:5690/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []  # no existing records yet
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    # "all" mode -> invite targets every verified server discovered from Wizarr
    bridge.client.create_invite.assert_called_once_with([1, 2, 3, 4, 5], 7, "35")
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")
    # brand-new member has no records to time-box; invite redemption sets expiry
    bridge.client.extend_user.assert_not_called()
    import store
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["invite_code"] == "abc"


def test_checkout_existing_member_time_boxes_all_records(bridge):
    bridge.client.list_server_ids.return_value = [1, 2, 3, 4, 5]
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = [147, 57, 106, 155, 204]
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_existing",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    # every one of the member's server records gets time-boxed
    assert sorted(c.args[0] for c in bridge.client.extend_user.call_args_list) == [57, 106, 147, 155, 204]
    for c in bridge.client.extend_user.call_args_list:
        assert c.args[1] == 35


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
    bridge.client.find_user_ids_by_email.return_value = [9, 10]
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_cycle",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    # renewal extends every server record for the member
    assert sorted(c.args for c in bridge.client.extend_user.call_args_list) == [(9, 35), (10, 35)]


def test_duplicate_event_is_ignored(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_ids_by_email.return_value = [9]
    event = {
        "type": "invoice.paid",
        "id": "evt_inv_cycle_dup",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    }
    bridge.handle_event(event)
    bridge.handle_event(event)
    bridge.client.extend_user.assert_called_once_with(9, 35)


def test_subscription_deleted_disables_all_records(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_ids_by_email.return_value = [147, 57, 106, 155, 204]
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "id": "evt_cancel",
        "data": {"object": {"customer": "cus_1"}},
    })
    # cancel must disable every server record, not just the first
    assert sorted(c.args[0] for c in bridge.client.disable_user.call_args_list) == [57, 106, 147, 155, 204]


def test_webhook_route_handles_stripe_object_event(bridge, monkeypatch):
    # Real Stripe webhooks arrive as a StripeObject (no dict .get), not a plain
    # dict — construct_event returns one. Drive the actual route to prove the
    # handler tolerates it and doesn't 500.
    import asyncio
    import json

    import stripe

    bridge.client.list_server_ids.return_value = [1, 2, 3]
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    payload = json.dumps({
        "id": "evt_route_1", "type": "checkout.session.completed",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    }).encode()

    monkeypatch.setattr(
        bridge.stripe.Webhook, "construct_event",
        lambda payload, sig, secret: stripe.Event.construct_from(json.loads(payload), "sk"),
    )

    class _Req:
        async def body(self):
            return payload

    resp = asyncio.run(bridge.stripe_webhook(_Req(), "t=1,v1=x"))
    assert resp == {"ok": True}
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")


def test_customer_email_reads_stripe_object(bridge, monkeypatch):
    # Customer.retrieve returns a StripeObject (no dict .get); customer_email
    # must read the field without crashing, and tolerate a missing email.
    import stripe

    monkeypatch.setattr(
        bridge.stripe.Customer, "retrieve",
        lambda cid: stripe.Customer.construct_from({"id": cid, "email": "c@x.com"}, "sk"),
    )
    assert bridge.customer_email("cus_1") == "c@x.com"

    monkeypatch.setattr(
        bridge.stripe.Customer, "retrieve",
        lambda cid: stripe.Customer.construct_from({"id": cid}, "sk"),
    )
    assert bridge.customer_email("cus_1") is None


def test_resolve_server_ids_explicit_list_overrides_discovery(bridge, monkeypatch):
    monkeypatch.setattr(bridge, "WIZARR_SERVER_IDS", "1,3,5")
    assert bridge.resolve_server_ids() == [1, 3, 5]
    bridge.client.list_server_ids.assert_not_called()


def test_resolve_falls_back_from_email_to_invite(bridge):
    import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    # email miss (Stripe email != Plex email) -> resolve via the stored invite code
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.client.find_user_ids_by_invite.return_value = [7, 8]
    ids = bridge.resolve_user_ids(bridge.client, bridge.MAP_DB_PATH, "cus_1", "a@x.com")
    assert ids == [7, 8]
    bridge.client.find_user_ids_by_invite.assert_called_once_with("abc")
