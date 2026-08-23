from datetime import datetime, timedelta, timezone

from fleet_monitor import config, store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)

# `latest` takes the same required floor `metric_ages` does. Where a test is
# about storage rather than about the floor, it passes one wide enough that the
# floor never participates in what is under test.
ANY_AGE = T0 - timedelta(days=30)


def test_write_and_read_latest(db):

    store.write_samples(db, "host:vermithor", T0, [
        Sample(metric="load.1m", value=0.46, kind="gauge"),
        Sample(metric="mem.total_bytes", value=16_642_768_896.0, kind="gauge"),
    ])

    assert store.latest(db, "host:vermithor", since=ANY_AGE) == {
        "load.1m": 0.46,
        "mem.total_bytes": 16_642_768_896.0,
    }


def test_latest_returns_the_newest_value_per_metric(db):

    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.01, "gauge")])
    store.write_samples(db, "host:meleys", T0 + timedelta(seconds=30),
                        [Sample("load.1m", 0.75, "gauge")])

    assert store.latest(db, "host:meleys", since=ANY_AGE)["load.1m"] == 0.75


def test_latest_is_empty_for_an_unknown_target(db):
    assert store.latest(db, "host:nope", since=ANY_AGE) == {}


def test_series_is_ordered_and_windowed(db):
    for offset in (0, 30, 60):
        store.write_samples(db, "host:syrax", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", offset / 100, "gauge")])

    points = store.series(db, "host:syrax", "load.1m", since=T0 + timedelta(seconds=15))

    assert [value for _, value in points] == [0.3, 0.6]
    assert points[0][0] == T0 + timedelta(seconds=30)


def test_metric_series_groups_the_requested_metrics_in_time_order(db):
    for offset, user, idle in ((0, 100.0, 900.0), (30, 150.0, 950.0)):
        store.write_samples(db, "host:syrax", T0 + timedelta(seconds=offset), [
            Sample("cpu.total.user", user, "counter"),
            Sample("cpu.total.idle", idle, "counter"),
            Sample("load.1m", 0.5, "gauge"),
        ])

    result = store.metric_series(
        db, "host:syrax", ("cpu.total.user", "cpu.total.idle"), since=ANY_AGE
    )

    assert result == {
        "cpu.total.user": ((T0, 100.0), (T0 + timedelta(seconds=30), 150.0)),
        "cpu.total.idle": ((T0, 900.0), (T0 + timedelta(seconds=30), 950.0)),
    }


def test_metric_series_windows_and_scopes_to_the_target(db):
    store.write_samples(db, "host:syrax", T0 - timedelta(hours=2),
                        [Sample("cpu.total.user", 1.0, "counter")])
    store.write_samples(db, "host:meleys", T0,
                        [Sample("cpu.total.user", 2.0, "counter")])
    store.write_samples(db, "host:syrax", T0,
                        [Sample("cpu.total.user", 3.0, "counter")])

    result = store.metric_series(
        db, "host:syrax", ("cpu.total.user",), since=T0 - timedelta(hours=1)
    )

    # a metric with no rows in the window is absent, not an empty series: the
    # caller cannot tell those apart and must not need to
    assert result == {"cpu.total.user": ((T0, 3.0),)}


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


def test_heartbeat_roundtrips(db):

    assert store.last_heartbeat(db) is None
    store.write_heartbeat(db, T0)
    assert store.last_heartbeat(db) == T0


def test_metric_ages_drops_a_metric_source_that_stopped_producing(db):
    # a veth renamed by a container restart is written once and never again.
    # Without the floor its one timestamp is still the oldest thing on the
    # host a week later, and every staleness signal derived from it is pinned.
    store.write_samples(db, "host:vermithor", T0 - timedelta(days=3),
                        [Sample("net.veth8a3f21.rx_bytes", 12.0, "counter")])
    store.write_samples(db, "host:vermithor", T0, [Sample("load.1m", 0.4, "gauge")])

    ages = store.metric_ages(db, "host:vermithor", since=T0 - timedelta(hours=24))

    assert set(ages) == {"load.1m"}
    assert ages["load.1m"] == T0


def test_metric_ages_keeps_a_metric_that_is_merely_late(db):
    # the floor must sit far above the staleness threshold, or nothing could
    # ever be reported stale: a late metric has to survive to be caught
    store.write_samples(db, "host:vermithor", T0 - timedelta(hours=6),
                        [Sample("disk.volume1.used_percent", 42.0, "gauge")])

    ages = store.metric_ages(db, "host:vermithor", since=T0 - timedelta(hours=24))

    assert ages["disk.volume1.used_percent"] == T0 - timedelta(hours=6)


def test_coverage_starts_at_the_first_heartbeat(db):

    assert store.coverage_since(db) is None
    store.write_heartbeat(db, T0)
    assert store.coverage_since(db) == T0


def test_coverage_survives_consecutive_rounds(db):
    for offset in (0, 30, 60, 90):
        store.write_heartbeat(db, T0 + timedelta(seconds=offset))

    assert store.coverage_since(db) == T0


def test_a_gap_in_the_rounds_restarts_coverage(db):
    # the collector was down for those hours. Nobody watched them, and an
    # empty incident history over unwatched hours is not proof of uptime.
    store.write_heartbeat(db, T0)
    store.write_heartbeat(db, T0 + timedelta(hours=8))

    assert store.coverage_since(db) == T0 + timedelta(hours=8)


def test_a_backwards_clock_step_restarts_coverage(db):
    store.write_heartbeat(db, T0)
    store.write_heartbeat(db, T0 - timedelta(hours=2))

    assert store.coverage_since(db) == T0 - timedelta(hours=2)


def test_latest_drops_a_reading_the_age_window_cannot_date(db):
    # samples live seven days and the age window is a day, so an unfloored read
    # hands back values metric_ages has already dropped: a number on the page
    # with no age accounted for anywhere, which is how a week-old disk reading
    # rendered under a bare "Healthy"
    store.write_samples(db, "host:caraxes", T0 - timedelta(days=7),
                        [Sample("disk.volume1.used_percent", 42.0, "gauge")])
    store.write_samples(db, "host:caraxes", T0, [Sample("load.1m", 0.1, "gauge")])

    floor = T0 - timedelta(hours=24)

    assert set(store.latest(db, "host:caraxes", since=floor)) == {"load.1m"}
    # the two reads agree by construction: same floor, same set
    assert set(store.latest(db, "host:caraxes", since=floor)) == set(
        store.metric_ages(db, "host:caraxes", since=floor)
    )


def test_latest_keeps_a_reading_that_is_merely_late(db):
    # the floor must not swallow the detection band: a metric between its
    # refresh interval and the window still has to be reported, with its age,
    # so the page can call it stale rather than silently drop it
    store.write_samples(db, "host:caraxes", T0 - timedelta(hours=6),
                        [Sample("disk.volume1.used_percent", 42.0, "gauge")])

    got = store.latest(db, "host:caraxes", since=T0 - timedelta(hours=24))

    assert got["disk.volume1.used_percent"] == 42.0


def test_a_slow_round_never_restarts_coverage(db):
    # the gap is measured between round starts, so a round's own duration is
    # spent inside it. A slow round can spend MAX_ROUND_SECONDS on ssh before
    # the loop sleeps VITALS_INTERVAL again: ~120s apart, collector never
    # stopped. A 90s tolerance tripped on that every 15 minutes and blanked
    # every uptime score for the following 24 hours.
    store.write_heartbeat(db, T0)
    store.write_heartbeat(db, T0 + timedelta(seconds=120))

    assert store.coverage_since(db) == T0


def test_the_coverage_gap_admits_a_worst_case_round(db):
    # stated as arithmetic so the constant cannot drift back under the round
    # duration it has to tolerate
    worst_case = config.MAX_ROUND_SECONDS + config.VITALS_INTERVAL

    assert store.COVERAGE_GAP.total_seconds() > worst_case


def test_init_db_is_idempotent(db):
    store.write_samples(db, "host:vhagar", T0, [Sample("load.1m", 0.14, "gauge")])

    assert store.latest(db, "host:vhagar", since=ANY_AGE)["load.1m"] == 0.14
