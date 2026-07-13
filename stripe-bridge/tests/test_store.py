import store


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


def test_mark_event_processed_dedup(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.mark_event_processed(db, "evt_1") is True
    assert store.mark_event_processed(db, "evt_1") is False
