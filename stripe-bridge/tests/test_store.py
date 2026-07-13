import store


def test_upsert_get_and_backfill(tmp_path):
    db = str(tmp_path / "bridge.db")
    store.init_db(db)

    assert store.get_mapping(db, "cus_1") is None

    store.upsert_pending(db, "cus_1", "a@example.com", "abc123")
    m = store.get_mapping(db, "cus_1")
    assert m == {
        "stripe_customer_id": "cus_1",
        "email": "a@example.com",
        "invite_code": "abc123",
        "wizarr_user_id": None,
    }

    # upsert again updates email, keeps row unique
    store.upsert_pending(db, "cus_1", "b@example.com", "abc123")
    assert store.get_mapping(db, "cus_1")["email"] == "b@example.com"

    # backfill resolved user id
    store.set_user_id(db, "cus_1", 42)
    assert store.get_mapping(db, "cus_1")["wizarr_user_id"] == 42
