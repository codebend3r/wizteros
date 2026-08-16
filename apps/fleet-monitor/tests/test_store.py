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


def test_metric_ages_drops_a_metric_source_that_stopped_producing(tmp_path):
    # a veth renamed by a container restart is written once and never again.
    # Without the floor its one timestamp is still the oldest thing on the
    # host a week later, and every staleness signal derived from it is pinned.
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_samples(db, "host:vermithor", T0 - timedelta(days=3),
                        [Sample("net.veth8a3f21.rx_bytes", 12.0, "counter")])
    store.write_samples(db, "host:vermithor", T0, [Sample("load.1m", 0.4, "gauge")])

    ages = store.metric_ages(db, "host:vermithor", since=T0 - timedelta(hours=24))

    assert set(ages) == {"load.1m"}
    assert ages["load.1m"] == T0


def test_metric_ages_keeps_a_metric_that_is_merely_late(tmp_path):
    # the floor must sit far above the staleness threshold, or nothing could
    # ever be reported stale: a late metric has to survive to be caught
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_samples(db, "host:vermithor", T0 - timedelta(hours=6),
                        [Sample("disk.volume1.used_percent", 42.0, "gauge")])

    ages = store.metric_ages(db, "host:vermithor", since=T0 - timedelta(hours=24))

    assert ages["disk.volume1.used_percent"] == T0 - timedelta(hours=6)


def test_coverage_starts_at_the_first_heartbeat(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    assert store.coverage_since(db) is None
    store.write_heartbeat(db, T0)
    assert store.coverage_since(db) == T0


def test_coverage_survives_consecutive_rounds(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    for offset in (0, 30, 60, 90):
        store.write_heartbeat(db, T0 + timedelta(seconds=offset))

    assert store.coverage_since(db) == T0


def test_a_gap_in_the_rounds_restarts_coverage(tmp_path):
    # the collector was down for those hours. Nobody watched them, and an
    # empty incident history over unwatched hours is not proof of uptime.
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_heartbeat(db, T0)
    store.write_heartbeat(db, T0 + timedelta(hours=8))

    assert store.coverage_since(db) == T0 + timedelta(hours=8)


def test_a_backwards_clock_step_restarts_coverage(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_heartbeat(db, T0)
    store.write_heartbeat(db, T0 - timedelta(hours=2))

    assert store.coverage_since(db) == T0 - timedelta(hours=2)


def test_init_db_is_idempotent(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_samples(db, "host:vhagar", T0, [Sample("load.1m", 0.14, "gauge")])
    store.init_db(db)

    assert store.latest(db, "host:vhagar")["load.1m"] == 0.14
