from datetime import datetime, timedelta, timezone

from fleet_monitor import series

T0 = datetime(2026, 8, 23, 12, 0, 0, tzinfo=timezone.utc)

GB = 1024**3


def _at(seconds):
    return T0 + timedelta(seconds=seconds)


def test_every_family_declares_either_names_or_a_prefix():
    # a family with neither would read nothing and draw an empty chart with no
    # error anywhere; with both, the prefix silently wins in series.history
    for family in series.FAMILIES.values():
        assert bool(family.metrics) != bool(family.prefix), family.kind


def test_family_keys_match_the_kind_they_carry():
    # the kind travels to the browser on every response, so a key that
    # disagreed with it would label one chart with another's name
    for key, family in series.FAMILIES.items():
        assert key == family.kind


# --- memory ------------------------------------------------------------


def test_memory_used_percent_is_judged_against_available_not_free():
    points = series.memory_used_series({
        "mem.total_bytes": ((_at(0), 16.0 * GB), (_at(30), 16.0 * GB)),
        "mem.available_bytes": ((_at(0), 12.0 * GB), (_at(30), 4.0 * GB)),
    })

    assert points == ((_at(0), 25.0), (_at(30), 75.0))


def test_memory_drops_a_moment_missing_either_gauge():
    # both come from one /proc/meminfo read, so a moment carrying only one of
    # them is a bad read; pairing it with a neighbour would invent a reading
    points = series.memory_used_series({
        "mem.total_bytes": ((_at(0), 8.0 * GB), (_at(30), 8.0 * GB)),
        "mem.available_bytes": ((_at(30), 2.0 * GB),),
    })

    assert points == ((_at(30), 75.0),)


def test_memory_drops_a_zero_total_rather_than_dividing_by_it():
    # a total of zero is a bad read, not a full machine
    points = series.memory_used_series({
        "mem.total_bytes": ((_at(0), 0.0),),
        "mem.available_bytes": ((_at(0), 0.0),),
    })

    assert points == ()


def test_memory_drops_available_above_total():
    points = series.memory_used_series({
        "mem.total_bytes": ((_at(0), 8.0 * GB),),
        "mem.available_bytes": ((_at(0), 9.0 * GB),),
    })

    assert points == ()


def test_memory_is_empty_for_a_host_that_reported_nothing():
    assert series.memory_used_series({}) == ()


# --- gpu ---------------------------------------------------------------


def test_gpu_reports_the_frequency_ratio_as_a_percentage():
    points = series.gpu_load_series({
        "gpu.freq_ratio": ((_at(0), 0.1333), (_at(30), 1.0)),
    })

    assert points == ((_at(0), 13.3), (_at(30), 100.0))


def test_gpu_clamps_a_card_reporting_past_its_own_ceiling():
    # pegged is a real state worth seeing; dropping it would hide the one
    # moment on the chart that mattered
    points = series.gpu_load_series({"gpu.freq_ratio": ((_at(0), 1.4),)})

    assert points == ((_at(0), 100.0),)


def test_gpu_drops_a_negative_ratio():
    assert series.gpu_load_series({"gpu.freq_ratio": ((_at(0), -0.5),)}) == ()


def test_gpu_is_empty_on_a_host_with_no_render_node():
    # three of the five boxes have no /dev/dri at all; an empty series draws a
    # legend entry with no line rather than a flat line along the axis
    assert series.gpu_load_series({}) == ()


# --- network -----------------------------------------------------------


def test_network_sums_every_interface_received_plus_sent():
    # 1000 bytes over 10s on each of four counters is 100 B/s each, 400 summed
    points = series.network_throughput_series({
        "net.eth0.rx_bytes": ((_at(0), 0.0), (_at(10), 1000.0)),
        "net.eth0.tx_bytes": ((_at(0), 0.0), (_at(10), 1000.0)),
        "net.eth1.rx_bytes": ((_at(0), 0.0), (_at(10), 1000.0)),
        "net.eth1.tx_bytes": ((_at(0), 0.0), (_at(10), 1000.0)),
    })

    assert points == ((_at(10), 400.0),)


def test_network_drops_the_pair_a_reboot_zeroed():
    # a counter that went backwards is a reset, and rendering the delta would
    # be a spike that never happened
    points = series.network_throughput_series({
        "net.eth0.rx_bytes": ((_at(0), 5000.0), (_at(10), 10.0), (_at(20), 1010.0)),
    })

    assert points == ((_at(20), 100.0),)


def test_network_needs_two_readings_before_it_can_answer():
    # a rate only exists between readings; one counter value is not a rate
    points = series.network_throughput_series({
        "net.eth0.rx_bytes": ((_at(0), 5000.0),),
    })

    assert points == ()


def test_network_is_empty_for_a_host_that_reported_nothing():
    assert series.network_throughput_series({}) == ()


# --- downsample --------------------------------------------------------


def test_downsample_leaves_a_short_series_alone():
    points = tuple((_at(index * 30), 10.0) for index in range(5))

    assert series.downsample(points, since=T0, until=_at(150), max_points=10) == points


def test_downsample_averages_each_bucket_and_dates_it_by_its_last_reading():
    # 4 readings over 4 seconds into 2 buckets: each point keeps a real
    # reading's timestamp, and its value is the mean of that bucket
    points = ((_at(0), 10.0), (_at(1), 20.0), (_at(2), 50.0), (_at(3), 60.0))

    assert series.downsample(points, since=T0, until=_at(4), max_points=2) == (
        (_at(1), 15.0),
        (_at(3), 55.0),
    )


def test_downsample_drops_empty_buckets_instead_of_filling_them():
    # a hole wider than a bucket stays a hole: nothing is emitted for the
    # seconds nothing was read, so the chart still breaks the line there
    points = ((_at(0), 10.0), (_at(1), 20.0), (_at(8), 30.0), (_at(9), 40.0))

    assert series.downsample(points, since=T0, until=_at(10), max_points=3) == (
        (_at(1), 15.0),
        (_at(9), 35.0),
    )


def test_downsample_bounds_a_weeks_worth_of_ticks():
    # a week of 30s ticks is 20k points; whatever the window, the answer stays
    # small enough for a browser to parse and an svg to draw
    week = 7 * 24 * 3600
    points = tuple((_at(index * 30), 10.0) for index in range(week // 30))

    assert len(series.downsample(points, since=T0, until=_at(week))) <= series.MAX_POINTS
