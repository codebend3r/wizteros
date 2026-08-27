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

