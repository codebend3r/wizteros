from datetime import datetime, timedelta, timezone

from fleet_monitor import store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def test_write_and_read_latest(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    store.write_samples(db, "host:vermithor", T0, [
        Sample(metric="load.1m", value=0.46, kind="gauge"),
        Sample(metric="mem.total_bytes", value=16_642_768_896.0, kind="gauge"),
    ])

    assert store.latest(db, "host:vermithor") == {
        "load.1m": 0.46,
        "mem.total_bytes": 16_642_768_896.0,
    }


def test_latest_returns_the_newest_value_per_metric(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.01, "gauge")])
    store.write_samples(db, "host:meleys", T0 + timedelta(seconds=30),
                        [Sample("load.1m", 0.75, "gauge")])

    assert store.latest(db, "host:meleys")["load.1m"] == 0.75


def test_latest_is_empty_for_an_unknown_target(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    assert store.latest(db, "host:nope") == {}


def test_series_is_ordered_and_windowed(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    for offset in (0, 30, 60):
        store.write_samples(db, "host:syrax", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", offset / 100, "gauge")])

    points = store.series(db, "host:syrax", "load.1m", since=T0 + timedelta(seconds=15))

    assert [value for _, value in points] == [0.3, 0.6]
    assert points[0][0] == T0 + timedelta(seconds=30)


def test_rate_divides_by_elapsed_seconds():
    assert store.rate((T0, 1000.0), (T0 + timedelta(seconds=10), 2000.0)) == 100.0


def test_rate_returns_none_on_a_counter_reset():
    # a reboot zeroes /proc counters; rendering that as a negative or a huge
    # spike would be a lie, so the delta is dropped
    assert store.rate((T0, 5000.0), (T0 + timedelta(seconds=10), 12.0)) is None


def test_rate_returns_none_on_zero_or_negative_elapsed():
    assert store.rate((T0, 1.0), (T0, 2.0)) is None
    assert store.rate((T0, 1.0), (T0 - timedelta(seconds=5), 2.0)) is None


def test_rate_series_drops_the_reset_pair_and_keeps_the_rest():
    points = (
        (T0, 100.0),
        (T0 + timedelta(seconds=10), 200.0),
        (T0 + timedelta(seconds=20), 5.0),      # reboot
        (T0 + timedelta(seconds=30), 105.0),
    )
    got = store.rate_series(points)

    assert [value for _, value in got] == [10.0, 10.0]
    assert [at for at, _ in got] == [T0 + timedelta(seconds=10), T0 + timedelta(seconds=30)]


def test_rate_series_needs_two_points():
    assert store.rate_series(((T0, 1.0),)) == ()
    assert store.rate_series(()) == ()


def test_heartbeat_roundtrips(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    assert store.last_heartbeat(db) is None
    store.write_heartbeat(db, T0)
    assert store.last_heartbeat(db) == T0


def test_init_db_is_idempotent(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_samples(db, "host:vhagar", T0, [Sample("load.1m", 0.14, "gauge")])
    store.init_db(db)

    assert store.latest(db, "host:vhagar")["load.1m"] == 0.14
