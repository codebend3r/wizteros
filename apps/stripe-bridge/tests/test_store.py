from stripe_bridge import store


def test_upsert_and_get(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.get_mapping(db, "cus_1") is None

    store.upsert_pending(db, "cus_1", "a@example.com", "abc123")
    assert store.get_mapping(db, "cus_1") == {
        "stripe_customer_id": "cus_1",
        "email": "a@example.com",
        "invite_code": "abc123",
    }

    # upsert again updates email, keeps row unique
    store.upsert_pending(db, "cus_1", "b@example.com", "abc123")
    assert store.get_mapping(db, "cus_1")["email"] == "b@example.com"

    # a new checkout re-points the mapping at the fresh invite code
    store.upsert_pending(db, "cus_1", "b@example.com", "xyz789")
    assert store.get_mapping(db, "cus_1")["invite_code"] == "xyz789"


def test_mark_event_processed_dedup(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.mark_event_processed(db, "evt_1") is True
    assert store.mark_event_processed(db, "evt_1") is False


def test_is_event_processed(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.is_event_processed(db, "evt_1") is False
    store.mark_event_processed(db, "evt_1")
    assert store.is_event_processed(db, "evt_1") is True


def test_tier_persisted_and_looked_up_by_email(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="gold")
    store.upsert_pending(db, "cus_2", "b@x.com", "def")  # tier defaults to None

    # lookup is lowercased and only includes rows that have a tier
    assert store.tiers_by_email(db) == {"a@x.com": "gold"}
    # existing mapping shape is unchanged (no tier key)
    assert store.get_mapping(db, "cus_1") == {
        "stripe_customer_id": "cus_1", "email": "A@X.com", "invite_code": "abc",
    }


def test_init_db_adds_tier_column_to_legacy_table(tmp_path):
    import sqlite3
    db = str(tmp_path / "legacy.db")
    # simulate a pre-tier prod DB
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)")
    store.init_db(db)  # must ALTER, not crash
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="silver")
    assert store.tiers_by_email(db) == {"a@x.com": "silver"}


def test_upsert_pending_by_email_inserts_placeholder_row(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending_by_email(db, "Code@X.com", "INV1", tier="gold")
    assert store.all_customer_tiers(db) == {"code@x.com": "gold"}


def test_upsert_pending_by_email_repoints_existing_stripe_row(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="silver")
    store.upsert_pending_by_email(db, "a@x.com", "INV2", tier="gold")
    # the Stripe-keyed row is updated in place; no second row appears
    assert store.all_customer_tiers(db) == {"a@x.com": "gold"}
    assert store.get_mapping(db, "cus_1")["invite_code"] == "INV2"
    assert store.get_mapping(db, "admin:a@x.com") is None


def test_upsert_pending_replaces_placeholder_on_real_checkout(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending_by_email(db, "a@x.com", "INV1", tier="gold")
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="silver")
    # one row per person: the admin placeholder yields to the Stripe mapping
    assert store.get_mapping(db, "admin:a@x.com") is None
    assert store.all_customer_tiers(db) == {"a@x.com": "silver"}


def test_subscribed_flag_defaults_false_and_checkout_sets_it(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    # admin-issued invite: no payment yet -> not subscribed
    store.upsert_pending_by_email(db, "a@x.com", "INV1", tier="gold")
    assert store.all_customer_rows(db)["a@x.com"]["subscribed"] is False
    # a real checkout is the confirmed-payment path -> subscribed
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="gold")
    assert store.all_customer_rows(db)["a@x.com"]["subscribed"] is True


def test_set_subscribed_toggles_every_row_for_email(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="gold")
    store.set_subscribed(db, "a@x.com", False)  # a cancel clears it
    assert store.all_customer_rows(db)["a@x.com"]["subscribed"] is False
    store.set_subscribed(db, "A@X.com", True)   # a renewal restores it (case-insensitive)
    assert store.all_customer_rows(db)["a@x.com"]["subscribed"] is True


def test_init_db_adds_subscribed_column_to_legacy_table(tmp_path):
    import sqlite3
    db = str(tmp_path / "legacy.db")
    # simulate a pre-payment-signal prod DB (has invited_at, lacks subscribed)
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, "
            "email TEXT, invite_code TEXT, tier TEXT, invited_at TEXT)"
        )
        c.execute(
            "INSERT INTO customer_map VALUES ('cus_legacy', 'old@x.com', 'i', 'gold', '2026-01-01T00:00:00+00:00')"
        )
    store.init_db(db)  # must ALTER, not crash, and default existing rows to False
    assert store.all_customer_rows(db)["old@x.com"]["subscribed"] is False


def test_all_customer_rows_exposes_invite_code(tmp_path):
    # The reconcile sweep's invite-code fallback (Plex email differs from the
    # Stripe email) reads the code straight off the row.
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="gold")
    store.stamp_invited(db, "manual@x.com")  # no bridge-issued code
    rows = store.all_customer_rows(db)
    assert rows["a@x.com"]["invite_code"] == "abc"
    assert rows["manual@x.com"]["invite_code"] is None


def test_stamp_invited_inserts_placeholder_without_tier_or_payment(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.stamp_invited(db, "New@X.com")
    row = store.all_customer_rows(db)["new@x.com"]
    assert row["invited_at"] is not None  # grace clock started
    assert row["tier"] is None            # no fabricated tier
    assert row["subscribed"] is False     # not a payment


def test_stamp_invited_preserves_existing_tier_and_flag(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "a@x.com", "abc", tier="gold")  # real payment: subscribed, gold
    store.stamp_invited(db, "A@X.com")
    row = store.all_customer_rows(db)["a@x.com"]
    assert row["tier"] == "gold"       # tier untouched
    assert row["subscribed"] is True   # payment flag untouched
    assert store.get_mapping(db, "cus_1")["invite_code"] == "abc"  # code untouched


def test_set_tier_updates_existing_row_keeping_invite_code(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="gold")
    store.set_tier(db, "a@x.com", "bronze")
    assert store.all_customer_tiers(db) == {"a@x.com": "bronze"}
    assert store.get_mapping(db, "cus_1")["invite_code"] == "abc"  # untouched


def test_set_tier_inserts_placeholder_for_unknown_email(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.set_tier(db, "New@X.com", "youth")
    assert store.all_customer_tiers(db) == {"new@x.com": "youth"}


def test_member_notes_roundtrip_lowercased_and_overwritten(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    assert store.get_member_notes(db, "a@x.com") == ""
    store.set_member_notes(db, "A@X.com", "prefers 4K")
    assert store.get_member_notes(db, "a@x.com") == "prefers 4K"  # keyed lowercased
    store.set_member_notes(db, "a@x.com", "moved abroad")
    assert store.get_member_notes(db, "A@X.com") == "moved abroad"


def test_init_db_adds_notes_table_to_legacy_db(tmp_path):
    import sqlite3
    db = str(tmp_path / "legacy.db")
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE customer_map (stripe_customer_id TEXT PRIMARY KEY, email TEXT, invite_code TEXT)")
    store.init_db(db)  # must create member_notes on an existing DB
    store.set_member_notes(db, "a@x.com", "legacy ok")
    assert store.get_member_notes(db, "a@x.com") == "legacy ok"


def test_event_history_roundtrip_newest_first_lowercased(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    assert store.events_for_email(db, "a@x.com") == []
    store.record_event(db, "A@X.com", "Signed up", "gold tier — invite emailed")
    store.record_event(db, "a@x.com", "Canceled")
    events = store.events_for_email(db, "A@X.com")
    assert [e["action"] for e in events] == ["Canceled", "Signed up"]
    assert events[1]["detail"] == "gold tier — invite emailed"
    assert events[0]["email"] == "a@x.com"
    assert all(e["at"] for e in events)


def test_record_event_never_raises(tmp_path):
    # A history write failure must not break the action it records.
    store.record_event(str(tmp_path / "missing" / "no.db"), "a@x.com", "Signed up")


def test_all_customer_tiers_includes_untiered_rows(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    store.upsert_pending(db, "cus_1", "A@X.com", "abc", tier="gold")
    store.upsert_pending(db, "cus_2", "b@x.com", "def")  # subscriber with no tier yet
    # unlike tiers_by_email, the untiered row is kept (value None)
    assert store.all_customer_tiers(db) == {"a@x.com": "gold", "b@x.com": None}


def test_customer_ids_for_email_excludes_admin_placeholders(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.customer_ids_for_email(db, "a@example.com") == []

    store.upsert_pending(db, "cus_1", "A@Example.com", "abc")
    store.upsert_pending_by_email(db, "b@example.com", "xyz")
    assert store.customer_ids_for_email(db, "a@example.com") == ["cus_1"]
    assert store.customer_ids_for_email(db, "b@example.com") == []


def test_member_tags_roundtrip_lowercased_and_cleared(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.all_member_tags(db) == {}
    store.set_member_tag(db, "A@Example.com", "vip")
    store.set_member_tag(db, "b@example.com", "hvu")
    assert store.all_member_tags(db) == {"a@example.com": "vip", "b@example.com": "hvu"}

    store.set_member_tag(db, "a@example.com", "hvu")  # overwrite
    assert store.all_member_tags(db)["a@example.com"] == "hvu"

    store.set_member_tag(db, "A@example.com", None)  # clear
    assert store.all_member_tags(db) == {"b@example.com": "hvu"}


def test_member_downloads_roundtrip_lowercased_and_overwritten(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.get_member_downloads(db, "a@example.com") is None
    assert store.all_member_downloads(db) == {}

    store.set_member_downloads(db, "A@Example.com", False)
    assert store.get_member_downloads(db, "a@example.com") is False

    store.set_member_downloads(db, "a@example.com", True)
    assert store.get_member_downloads(db, "A@example.com") is True
    assert store.all_member_downloads(db) == {"a@example.com": True}


def test_member_links_are_keyed_lowercased_and_clearable(tmp_path):
    dbp = str(tmp_path / "b.db")
    store.init_db(dbp)
    store.set_member_link(dbp, stripe_email="Pays@X.com", plex_email="Watches@X.com")
    assert store.get_member_link(dbp, "pays@x.com") == "watches@x.com"
    assert store.get_member_link(dbp, "PAYS@X.COM") == "watches@x.com"
    assert store.all_member_links(dbp) == {"pays@x.com": "watches@x.com"}
    # Re-pointing replaces rather than duplicating; one payer, one owner.
    store.set_member_link(dbp, stripe_email="pays@x.com", plex_email="other@x.com")
    assert store.all_member_links(dbp) == {"pays@x.com": "other@x.com"}
    store.set_member_link(dbp, stripe_email="pays@x.com", plex_email=None)
    assert store.all_member_links(dbp) == {}
    assert store.get_member_link(dbp, "pays@x.com") is None


def test_one_person_can_pay_under_several_addresses(tmp_path):
    dbp = str(tmp_path / "b.db")
    store.init_db(dbp)
    store.set_member_link(dbp, stripe_email="a@x.com", plex_email="one@x.com")
    store.set_member_link(dbp, stripe_email="b@x.com", plex_email="one@x.com")
    assert store.all_member_links(dbp) == {"a@x.com": "one@x.com", "b@x.com": "one@x.com"}


def test_duplicate_rows_for_one_email_resolve_to_the_newest_real_customer(tmp_path):
    """Several customers can share an email; which one answers must not be luck.

    The map is keyed on the Stripe customer id, so a member who checked out
    more than once has a row per attempt. Collapsing them by email with no
    ordering let whichever row SQLite happened to return last decide the
    member's tier, invite code, and the customer id behind their Stripe link.

    subscribed and invited_at cannot break the tie: both are written across
    every row sharing the email. The newest checkout is the live one, so
    insertion order is the signal that actually distinguishes them.
    """
    dbp = str(tmp_path / "b.db")
    store.init_db(dbp)
    store.upsert_pending(dbp, "cus_old", "dupe@x.com", "OLD", tier="bronze")
    store.upsert_pending(dbp, "cus_mid", "dupe@x.com", "MID", tier="gold")
    store.upsert_pending(dbp, "cus_newest", "dupe@x.com", "NEWEST", tier="silver")

    row = store.all_customer_rows(dbp)["dupe@x.com"]
    assert row["customer_id"] == "cus_newest"
    assert row["invite_code"] == "NEWEST"
    assert row["tier"] == "silver"
    # One entry per email either way; this is about which one, not how many.
    assert len(store.all_customer_rows(dbp)) == 1


def test_a_real_customer_outranks_an_admin_placeholder(tmp_path):
    """An "admin:<email>" row carries no Stripe identity; a cus_ row does.

    Recency loses to that: a placeholder added after a real checkout would
    otherwise blank the member's customer id and their Stripe link with it.
    """
    import sqlite3

    dbp = str(tmp_path / "b.db")
    store.init_db(dbp)
    store.upsert_pending(dbp, "cus_real", "both@x.com", "REAL", tier="gold")
    with sqlite3.connect(dbp) as c:  # a later placeholder, higher rowid
        c.execute(
            "INSERT INTO customer_map (stripe_customer_id, email, invite_code, tier) "
            "VALUES ('admin:both@x.com', 'both@x.com', 'ADMIN', 'bronze')")

    row = store.all_customer_rows(dbp)["both@x.com"]
    assert row["customer_id"] == "cus_real"
    assert row["invite_code"] == "REAL"


def test_one_row_per_email_is_unaffected(tmp_path):
    dbp = str(tmp_path / "b.db")
    store.init_db(dbp)
    store.upsert_pending(dbp, "cus_1", "solo@x.com", "ONE", tier="silver")
    rows = store.all_customer_rows(dbp)
    assert len(rows) == 1
    assert rows["solo@x.com"]["customer_id"] == "cus_1"
    assert rows["solo@x.com"]["invite_code"] == "ONE"


def test_all_events_spans_every_member_newest_first(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)
    assert store.all_events(db) == []
    store.record_event(db, "A@X.com", "Signed up", "gold tier — invite emailed")
    store.record_event(db, "b@x.com", "Signed up", "bronze tier — invite emailed")
    store.record_event(db, "a@x.com", "Canceled", "subscription ended — 1 server record(s) disabled")
    events = store.all_events(db)
    assert [(e["email"], e["action"]) for e in events] == [
        ("a@x.com", "Canceled"), ("b@x.com", "Signed up"), ("a@x.com", "Signed up")]
    assert store.all_events(db, limit=1)[0]["action"] == "Canceled"
