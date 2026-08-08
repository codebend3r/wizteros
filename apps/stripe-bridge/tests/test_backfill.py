import os
import sys
from unittest.mock import MagicMock

os.environ.setdefault("WIZARR_BASE_URL", "http://wizarr.test")
os.environ.setdefault("WIZARR_API_KEY", "k")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import backfill_invited_expiry as backfill

from stripe_bridge import store


def _setup(tmp_path, monkeypatch, emails):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    monkeypatch.setattr(backfill, "MAP_DB_PATH", db)
    client = MagicMock()
    client.find_user_ids_by_email.return_value = [9, 10]
    monkeypatch.setattr(backfill, "WizarrClient", lambda *a, **k: client)
    monkeypatch.setattr(backfill, "EMAILS", emails)
    return db, client


def test_backfill_stamps_invited_and_expires_a_plain_member(tmp_path, monkeypatch):
    db, client = _setup(tmp_path, monkeypatch, ["new@x.com"])
    backfill.run(dry_run=False)
    row = store.all_customer_rows(db)["new@x.com"]
    assert row["invited_at"] is not None    # reads as Invited
    assert row["subscribed"] is False       # not marked a subscriber
    assert row["tier"] is None              # tier stays Unknown
    # every Wizarr record gets the 14-day expiry
    assert sorted(c.args[0] for c in client.set_expiry.call_args_list) == [9, 10]
    events = store.events_for_email(db, "new@x.com")
    assert events[0]["action"] == "Invited"
    assert "access ends" in events[0]["detail"]


def test_backfill_skips_vip_and_already_subscribed(tmp_path, monkeypatch):
    db, client = _setup(tmp_path, monkeypatch, ["vip@x.com", "paid@x.com"])
    store.set_member_tag(db, "vip@x.com", "vip")
    store.upsert_pending(db, "cus_1", "paid@x.com", "abc", tier="gold")  # confirmed payment
    backfill.run(dry_run=False)
    client.set_expiry.assert_not_called()          # neither member is time-boxed
    assert "vip@x.com" not in store.all_customer_rows(db)  # VIP never stamped


def test_backfill_hvu_is_treated_as_a_normal_member(tmp_path, monkeypatch):
    db, client = _setup(tmp_path, monkeypatch, ["hvu@x.com"])
    store.set_member_tag(db, "hvu@x.com", "hvu")  # administrative label, not protected
    backfill.run(dry_run=False)
    assert store.all_customer_rows(db)["hvu@x.com"]["invited_at"] is not None
    assert sorted(c.args[0] for c in client.set_expiry.call_args_list) == [9, 10]


def test_backfill_dry_run_writes_nothing(tmp_path, monkeypatch):
    db, client = _setup(tmp_path, monkeypatch, ["new@x.com"])
    backfill.run(dry_run=True)
    client.set_expiry.assert_not_called()
    assert "new@x.com" not in store.all_customer_rows(db)
