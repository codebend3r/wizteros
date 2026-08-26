from datetime import datetime, timedelta, timezone

from fleet_monitor import cpu

T0 = datetime(2026, 8, 23, 12, 0, 0, tzinfo=timezone.utc)


def _at(seconds):
    return T0 + timedelta(seconds=seconds)


def test_metrics_cover_every_proc_stat_field():
    # the endpoint asks the store for exactly what parse_stat writes; a field
    # missing here would silently skew every total the derivation sums
    assert cpu.METRICS == (
        "cpu.total.user",
        "cpu.total.nice",
        "cpu.total.system",
        "cpu.total.idle",
        "cpu.total.iowait",
        "cpu.total.irq",
        "cpu.total.softirq",
        "cpu.total.steal",
    )


def test_busy_series_derives_percent_from_counter_deltas():
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 0.0), (_at(30), 25.0), (_at(60), 75.0)),
        "cpu.total.idle": ((_at(0), 0.0), (_at(30), 75.0), (_at(60), 125.0)),
    })

    assert points == ((_at(30), 25.0), (_at(60), 50.0))


def test_busy_series_counts_iowait_as_not_busy():
    # iowait is time the CPU spent waiting, not working; counting it as busy
    # would paint a disk-bound NAS as compute-bound
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 0.0), (_at(30), 20.0)),
        "cpu.total.idle": ((_at(0), 0.0), (_at(30), 40.0)),
        "cpu.total.iowait": ((_at(0), 0.0), (_at(30), 40.0)),
    })

    assert points == ((_at(30), 20.0),)


def test_busy_series_drops_the_delta_across_a_reboot():
    # a reboot zeroes /proc/stat; that delta rendered anyway would be a spike
    # to 100% that never happened
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 5000.0), (_at(30), 10.0), (_at(60), 20.0)),
        "cpu.total.idle": ((_at(0), 5000.0), (_at(30), 30.0), (_at(60), 70.0)),
    })

    assert points == ((_at(60), 20.0),)


def test_busy_series_skips_a_tick_that_never_reported_idle():
    # without idle a tick cannot be judged; the pair spanning it is still a
    # true average over the wider interval, so the series bridges rather than
    # inventing a value
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 0.0), (_at(30), 10.0), (_at(60), 50.0)),
        "cpu.total.idle": ((_at(0), 0.0), (_at(60), 50.0)),
    })

    assert points == ((_at(60), 50.0),)


def test_busy_series_drops_a_pair_whose_field_sets_differ():
    # a tick that recorded fewer fields than its neighbor makes the total
    # delta wrong by whatever the missing counters advanced; unjudgeable
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 0.0), (_at(30), 50.0)),
        "cpu.total.idle": ((_at(0), 0.0), (_at(30), 50.0)),
        "cpu.total.steal": ((_at(30), 5.0),),
    })

    assert points == ()


def test_busy_series_drops_a_pair_with_no_elapsed_work():
    points = cpu.busy_series({
        "cpu.total.user": ((_at(0), 100.0), (_at(30), 100.0)),
        "cpu.total.idle": ((_at(0), 200.0), (_at(30), 200.0)),
    })

    assert points == ()


def test_busy_series_is_empty_for_no_input():
    assert cpu.busy_series({}) == ()


def test_downsample_leaves_a_short_series_alone():
    series = tuple((_at(index * 30), 10.0) for index in range(5))

    assert (
        cpu.downsample(series, since=T0, until=_at(150), max_points=10) == series
    )


def test_downsample_averages_each_bucket_and_dates_it_by_its_last_reading():
    # 4 readings over 4 seconds into 2 buckets: each point keeps a real
    # reading's timestamp, and its value is the mean of that bucket
    series = ((_at(0), 10.0), (_at(1), 20.0), (_at(2), 50.0), (_at(3), 60.0))

    assert cpu.downsample(series, since=T0, until=_at(4), max_points=2) == (
        (_at(1), 15.0),
        (_at(3), 55.0),
    )


def test_downsample_drops_empty_buckets_instead_of_filling_them():
    # a hole wider than a bucket stays a hole: nothing is emitted for the
    # seconds nothing was read, so the chart still breaks the line there
    series = ((_at(0), 10.0), (_at(1), 20.0), (_at(8), 30.0), (_at(9), 40.0))

    assert cpu.downsample(series, since=T0, until=_at(10), max_points=3) == (
        (_at(1), 15.0),
        (_at(9), 35.0),
    )


def test_downsample_bounds_a_weeks_worth_of_ticks():
    # a week of 30s ticks is 20k points; whatever the window, the answer stays
    # small enough for a browser to parse and an svg to draw
    week = 7 * 24 * 3600
    series = tuple((_at(index * 30), 10.0) for index in range(week // 30))

    assert len(cpu.downsample(series, since=T0, until=_at(week))) <= cpu.MAX_POINTS
