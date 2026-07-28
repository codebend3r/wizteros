import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# Provide required env before importing the module.
os.environ.update({
    "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "INVITE_EXPIRES_DAYS": "14", "ACCESS_DURATION": "35",
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test", "PUBLIC_INVITE_BASE": "http://inv.test",
    "MAP_DB_PATH": "/tmp/does-not-matter.db",
})

FIXTURE_LIBRARIES = [
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 22, "name": "06. Kid Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 24, "name": "02. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
]


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    """Fresh bridge module per test: temp SQLite db, mocked Wizarr client and email."""
    import importlib
    from stripe_bridge import stripe_wizarr_bridge as b
    importlib.reload(b)
    dbp = str(tmp_path / "bridge.db")
    monkeypatch.setattr(b, "MAP_DB_PATH", dbp)
    from stripe_bridge import store
    store.init_db(dbp)
    b.client = MagicMock()
    monkeypatch.setattr(b, "send_invite_email", MagicMock())
    return b


def test_checkout_brand_new_member_invites_for_its_tier(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://wizarr-lan:5690/j/abc"}
    bridge.client.find_users_by_email.return_value = []  # no existing records yet
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "silver"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 14, "35", library_ids=[17, 20, 22, 24], allow_downloads=False)
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")
    # brand-new member has no records to time-box; invite redemption sets expiry
    bridge.client.set_expiry.assert_not_called()
    from stripe_bridge import store
    assert store.get_mapping(bridge.MAP_DB_PATH, "cus_1")["invite_code"] == "abc"
    # checkout is the confirmed-payment signal that drives "Subscribed Monthly"
    assert store.all_customer_rows(bridge.MAP_DB_PATH)["a@x.com"]["subscribed"] is True
    events = store.events_for_email(bridge.MAP_DB_PATH, "a@x.com")
    assert events[0]["action"] == "Signed up"
    assert "silver" in events[0]["detail"]


def test_checkout_existing_member_keeps_access_when_servers_covered(bridge):
    # Redeeming re-scopes the share in place on covered servers, so a member
    # whose servers all stay in scope keeps access through the invite window.
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_users_by_email.return_value = [
        {"id": 147, "server": "Vermithor"},
        {"id": 57, "server": "Meleys"},
    ]
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_covered",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "bronze"}}},
    })
    bridge.client.disable_user.assert_not_called()
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")


def test_checkout_existing_covered_member_expiry_resets_to_access_duration(bridge):
    # A covered member keeps access without ever redeeming the new invite, so
    # the checkout itself must stamp the paid expiry (now + ACCESS_DURATION)
    # on every surviving record — otherwise a short pre-signup window (e.g. the
    # 14-day Invited backfill) survives the purchase.
    from datetime import datetime, timedelta, timezone
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_users_by_email.return_value = [
        {"id": 147, "server": "Vermithor"},
        {"id": 57, "server": "Meleys"},
    ]
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_covered_expiry",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    calls = bridge.client.set_expiry.call_args_list
    assert sorted(c.args[0] for c in calls) == [57, 147]
    expiries = {c.args[1] for c in calls}
    assert len(expiries) == 1  # one absolute expiry applied uniformly
    expected = datetime.now(timezone.utc) + timedelta(days=35)
    assert abs((datetime.fromisoformat(expiries.pop()) - expected).total_seconds()) < 60


def test_checkout_vip_member_is_never_time_boxed(bridge):
    from stripe_bridge import store
    store.set_member_tag(bridge.MAP_DB_PATH, "vip@x.com", "vip")
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_users_by_email.return_value = [
        {"id": 147, "server": "Vermithor"},
        {"id": 57, "server": "Meleys"},
    ]
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_vip",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "VIP@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    bridge.client.set_expiry.assert_not_called()
    bridge.client.disable_user.assert_not_called()


def test_checkout_existing_member_resets_all_records_when_a_server_drops(bridge):
    # Wizarr has no per-server unshare (disable severs the whole plex.tv
    # friendship), so when the new tier leaves a current server uncovered the
    # member is fully reset; redeeming the emailed invite re-grants the tier.
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_users_by_email.return_value = [
        {"id": 147, "server": "Vermithor"},
        {"id": 57, "server": "Meleys"},
        {"id": 106, "server": "Vhagar"},   # not covered by bronze scope
        {"id": 155, "server": "Syrax"},    # not covered by bronze scope
        {"id": 204, "server": "Caraxes"},  # 99. private only -> not covered
    ]
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_existing",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "bronze"}}},
    })
    # every record is disabled (account-wide reset), none merely time-boxed
    assert sorted(c.args[0] for c in bridge.client.disable_user.call_args_list) == [57, 106, 147, 155, 204]
    bridge.client.set_expiry.assert_not_called()
    # the invite email still goes out — it is the re-join path
    bridge.send_invite_email.assert_called_once_with("a@x.com", "http://inv.test/j/abc")


def test_checkout_brand_new_member_disables_nothing(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_checkout_fresh",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "new@x.com"},
                            "metadata": {"tier": "youth"}}},
    })
    bridge.client.disable_user.assert_not_called()


def test_invoice_paid_first_charge_is_skipped(bridge):
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_skip",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_create"}},
    })
    bridge.client.set_expiry.assert_not_called()


def test_invoice_paid_renewal_extends(bridge):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    store.set_subscribed(bridge.MAP_DB_PATH, "a@x.com", False)  # prove the renewal restores it
    bridge.client.find_user_ids_by_email.return_value = [9, 10]
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_cycle",
        "data": {"object": {"customer": "cus_1", "customer_email": "a@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    # renewal sets expiry on every server record, all to the same absolute date
    calls = bridge.client.set_expiry.call_args_list
    assert sorted(c.args[0] for c in calls) == [9, 10]
    assert len({c.args[1] for c in calls}) == 1  # one expiry applied uniformly
    # a paid invoice re-affirms the confirmed-payment flag
    assert store.all_customer_rows(bridge.MAP_DB_PATH)["a@x.com"]["subscribed"] is True
    events = store.events_for_email(bridge.MAP_DB_PATH, "a@x.com")
    assert events[0]["action"] == "Payment received"
    assert "access extended to" in events[0]["detail"]


def test_invoice_paid_renewal_leaves_vip_expiry_alone(bridge):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "vip@x.com", "abc")
    store.set_member_tag(bridge.MAP_DB_PATH, "vip@x.com", "vip")
    bridge.client.find_user_ids_by_email.return_value = [9, 10]  # would be stamped if not VIP
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_vip",
        "data": {"object": {"customer": "cus_1", "customer_email": "vip@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    bridge.client.set_expiry.assert_not_called()
    # the payment itself is still acknowledged
    assert store.all_customer_rows(bridge.MAP_DB_PATH)["vip@x.com"]["subscribed"] is True
    events = store.events_for_email(bridge.MAP_DB_PATH, "vip@x.com")
    assert events[0]["action"] == "Payment received"


def test_reconcile_stamps_new_member_records_that_joined_without_expiry(bridge):
    # Wizarr never applies an invite's duration to the records it creates, so a
    # brand-new member redeems into expires=None. The sweep must stamp
    # invited_at + ACCESS_DURATION on exactly those records.
    from datetime import datetime, timedelta, timezone
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "new@x.com", "abc", tier="gold")
    bridge.client.list_users.return_value = [
        {"id": 259, "email": "new@x.com", "server": "Vermithor", "expires": None},
        {"id": 260, "email": "new@x.com", "server": "Meleys", "expires": None},
        {"id": 9, "email": "other@x.com", "server": "Vermithor", "expires": None},
    ]
    stamped = bridge.reconcile_pending_expiries()
    assert stamped == 2
    calls = bridge.client.set_expiry.call_args_list
    assert sorted(c.args[0] for c in calls) == [259, 260]
    invited_at = datetime.fromisoformat(
        store.all_customer_rows(bridge.MAP_DB_PATH)["new@x.com"]["invited_at"])
    expected = invited_at + timedelta(days=35)
    assert all(datetime.fromisoformat(c.args[1]) == expected for c in calls)
    events = store.events_for_email(bridge.MAP_DB_PATH, "new@x.com")
    assert events[0]["action"] == "Expiry stamped"


def test_reconcile_skips_vips_and_records_with_an_expiry(bridge):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "vip@x.com", "abc")
    store.set_member_tag(bridge.MAP_DB_PATH, "vip@x.com", "vip")
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_2", "paid@x.com", "def")
    bridge.client.list_users.return_value = [
        {"id": 1, "email": "vip@x.com", "server": "Vermithor", "expires": None},
        {"id": 2, "email": "paid@x.com", "server": "Vermithor", "expires": "2099-01-01T00:00:00"},
    ]
    assert bridge.reconcile_pending_expiries() == 0
    bridge.client.set_expiry.assert_not_called()


def test_reconcile_ignores_unsubscribed_members(bridge):
    from stripe_bridge import store
    store.stamp_invited(bridge.MAP_DB_PATH, "invited@x.com")  # invited, never paid
    bridge.client.list_users.return_value = [
        {"id": 1, "email": "invited@x.com", "server": "Vermithor", "expires": None},
    ]
    assert bridge.reconcile_pending_expiries() == 0
    bridge.client.set_expiry.assert_not_called()
    # nothing pending at all -> the slow Wizarr users call is skipped entirely
    bridge.client.list_users.assert_not_called()


def test_reconcile_never_stamps_a_date_already_in_the_past(bridge, monkeypatch):
    # A stale subscribed row (e.g. expiry manually cleared long after signup)
    # must not let a background sweep revoke access with a past-dated expiry.
    import sqlite3
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "old@x.com", "abc")
    with sqlite3.connect(bridge.MAP_DB_PATH) as c:
        c.execute("UPDATE customer_map SET invited_at = '2020-01-01T00:00:00+00:00'")
    bridge.client.list_users.return_value = [
        {"id": 1, "email": "old@x.com", "server": "Vermithor", "expires": None},
    ]
    assert bridge.reconcile_pending_expiries() == 0
    bridge.client.set_expiry.assert_not_called()


def test_duplicate_event_is_ignored(bridge):
    from stripe_bridge import store
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
    bridge.client.set_expiry.assert_called_once()
    assert bridge.client.set_expiry.call_args.args[0] == 9


def test_subscription_deleted_disables_all_records(bridge):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    bridge.client.find_user_ids_by_email.return_value = [147, 57, 106, 155, 204]
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "id": "evt_cancel",
        "data": {"object": {"customer": "cus_1"}},
    })
    # cancel must disable every server record, not just the first
    assert sorted(c.args[0] for c in bridge.client.disable_user.call_args_list) == [57, 106, 147, 155, 204]
    # a deleted subscription clears the confirmed-payment flag
    assert store.all_customer_rows(bridge.MAP_DB_PATH)["a@x.com"]["subscribed"] is False
    events = store.events_for_email(bridge.MAP_DB_PATH, "a@x.com")
    assert events[0]["action"] == "Canceled"
    assert "5 server record(s)" in events[0]["detail"]


def test_webhook_route_handles_stripe_object_event(bridge, monkeypatch):
    # Real Stripe webhooks arrive as a StripeObject (no dict .get), not a plain
    # dict — construct_event returns one. Drive the actual route to prove the
    # handler tolerates it and doesn't 500.
    import asyncio
    import json

    import stripe

    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
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


def test_resolve_falls_back_from_email_to_invite(bridge):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    # email miss (Stripe email != Plex email) -> resolve via the stored invite code
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.client.find_user_ids_by_invite.return_value = [7, 8]
    ids = bridge.resolve_user_ids(bridge.client, bridge.MAP_DB_PATH, "cus_1", "a@x.com")
    assert ids == [7, 8]
    bridge.client.find_user_ids_by_invite.assert_called_once_with("abc")


def test_webhook_route_rejects_invalid_signature(bridge, monkeypatch):
    import asyncio

    import stripe
    from fastapi import HTTPException

    def _raise(payload, sig, secret):
        raise stripe.error.SignatureVerificationError("bad sig", sig)

    monkeypatch.setattr(bridge.stripe.Webhook, "construct_event", _raise)

    class _Req:
        async def body(self):
            return b"{}"

    with pytest.raises(HTTPException) as exc:
        asyncio.run(bridge.stripe_webhook(_Req(), "t=1,v1=bad"))
    assert exc.value.status_code == 400
    bridge.client.create_invite.assert_not_called()


def test_webhook_served_on_both_funnel_paths(bridge):
    # Tailscale Funnel strips the /stripe prefix; direct/local calls don't.
    # Both paths must route to the same handler.
    # (openapi()["paths"] is used instead of walking bridge.app.routes
    # directly: with admin.router mounted via include_router, installed
    # fastapi>=0.139 represents each included router as an opaque
    # _IncludedRouter wrapper with no .path attribute until resolved.)
    paths = set(bridge.app.openapi()["paths"])
    assert {"/stripe/webhook", "/webhook"} <= paths


def test_checkout_without_email_creates_nothing(bridge):
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_no_email",
        "data": {"object": {"id": "cs_1", "customer": "cus_1"}},
    })
    bridge.client.create_invite.assert_not_called()
    bridge.send_invite_email.assert_not_called()


def test_checkout_falls_back_to_customer_email_field(bridge):
    # Some checkout sessions carry customer_email instead of customer_details.
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_fallback_email",
        "data": {"object": {"id": "cs_1", "customer": "cus_1", "customer_email": "b@x.com"}},
    })
    bridge.send_invite_email.assert_called_once_with("b@x.com", "http://inv.test/j/abc")


def test_invoice_paid_renewal_with_no_records_is_noop(bridge):
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "invoice.paid",
        "id": "evt_inv_orphan",
        "data": {"object": {"customer": "cus_missing", "customer_email": "ghost@x.com",
                            "billing_reason": "subscription_cycle"}},
    })
    bridge.client.set_expiry.assert_not_called()


def test_cancel_with_no_records_is_noop(bridge, monkeypatch):
    monkeypatch.setattr(bridge, "customer_email", lambda cid: "ghost@x.com")
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "id": "evt_cancel_orphan",
        "data": {"object": {"customer": "cus_missing"}},
    })
    bridge.client.disable_user.assert_not_called()


def test_cancel_prefers_stored_email_over_stripe_lookup(bridge, monkeypatch):
    from stripe_bridge import store
    store.upsert_pending(bridge.MAP_DB_PATH, "cus_1", "a@x.com", "abc")
    stripe_lookup = MagicMock()
    monkeypatch.setattr(bridge, "customer_email", stripe_lookup)
    bridge.client.find_user_ids_by_email.return_value = [9]
    bridge.handle_event({
        "type": "customer.subscription.deleted",
        "id": "evt_cancel_mapped",
        "data": {"object": {"customer": "cus_1"}},
    })
    # mapping has the email, so no Stripe API round-trip is needed
    stripe_lookup.assert_not_called()
    bridge.client.find_user_ids_by_email.assert_called_once_with("a@x.com")
    bridge.client.disable_user.assert_called_once_with(9)


def test_checkout_without_tier_metadata_defaults_to_bronze(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_no_tier",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    })
    # bronze: no 4K library, downloads off (kid shows is not 4K, so it's included)
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 14, "35", library_ids=[17, 22, 24], allow_downloads=False)


def test_checkout_gold_enables_downloads(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_gold",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 14, "35", library_ids=[17, 20, 22, 24], allow_downloads=True)


def test_checkout_youth_scopes_to_youth_libraries_only(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_youth",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "youth"}}},
    })
    bridge.client.create_invite.assert_called_once_with(
        [1, 2], 14, "35", library_ids=[20, 22, 24], allow_downloads=True)


def test_checkout_with_no_libraries_raises_so_stripe_retries(bridge):
    # Wizarr returned no libraries at all -- resolving zero library_ids must
    # not silently issue an invite to nothing; raise so the route 500s and
    # Stripe retries the event later.
    bridge.client.list_libraries.return_value = []
    with pytest.raises(RuntimeError):
        bridge.handle_event({
            "type": "checkout.session.completed",
            "id": "evt_no_libraries",
            "data": {"object": {"id": "cs_1", "customer": "cus_1",
                                "customer_details": {"email": "a@x.com"}}},
        })
    bridge.client.create_invite.assert_not_called()
    bridge.send_invite_email.assert_not_called()


def test_failed_event_is_not_marked_processed(bridge):
    # A crash mid-handler (e.g. Wizarr resolves zero libraries) must not mark
    # the event processed, so Stripe's retry of the same event id can still
    # be handled instead of being dropped as a dupe.
    event = {
        "type": "checkout.session.completed",
        "id": "evt_retry_me",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"}}},
    }
    bridge.client.list_libraries.return_value = []
    with pytest.raises(RuntimeError):
        bridge.handle_event(event)
    bridge.client.create_invite.assert_not_called()

    # fix the mock and re-handle the SAME event id -- it must not be skipped
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event(event)
    bridge.client.create_invite.assert_called_once()


def test_checkout_records_tier_for_the_customer(bridge):
    bridge.client.list_libraries.return_value = FIXTURE_LIBRARIES
    bridge.client.create_invite.return_value = {"code": "abc", "url": "http://x/j/abc"}
    bridge.client.find_user_ids_by_email.return_value = []
    bridge.handle_event({
        "type": "checkout.session.completed",
        "id": "evt_tier_1",
        "data": {"object": {"id": "cs_1", "customer": "cus_1",
                            "customer_details": {"email": "a@x.com"},
                            "metadata": {"tier": "gold"}}},
    })
    from stripe_bridge import store
    assert store.tiers_by_email(bridge.MAP_DB_PATH) == {"a@x.com": "gold"}


def test_send_invite_email_sends_via_smtp_starttls(monkeypatch):
    import importlib
    from stripe_bridge import mailer as b
    importlib.reload(b)

    sent = {}

    class FakeSMTP:
        """Stands in for smtplib.SMTP; records each step of the conversation."""

        def __init__(self, host, port):
            sent["host"], sent["port"] = host, port

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def starttls(self):
            sent["starttls"] = True

        def login(self, user, password):
            sent["login"] = (user, password)

        def send_message(self, msg):
            sent["msg"] = msg

    monkeypatch.setattr(b.smtplib, "SMTP", FakeSMTP)
    b.send_invite_email("to@x.com", "http://inv.test/j/abc")

    assert (sent["host"], sent["port"]) == ("smtp.test", 587)
    assert sent["starttls"] is True
    assert sent["login"] == ("u", "p")
    assert sent["msg"]["To"] == "to@x.com"
    assert sent["msg"]["From"] == "server@test"
    assert sent["msg"]["Subject"] == "Your Westeroz access link"
    # multipart/alternative: plain-text fallback plus the styled HTML part,
    # both carrying the invite link.
    assert sent["msg"].get_content_type() == "multipart/alternative"
    plain = sent["msg"].get_body(preferencelist=("plain",)).get_content()
    html = sent["msg"].get_body(preferencelist=("html",)).get_content()
    assert "http://inv.test/j/abc" in plain
    assert 'href="http://inv.test/j/abc"' in html
    assert "Set up your account" in html
