"""Aggregate CPU busy percent, derived from the raw jiffy counters.

/proc/stat reports monotonic jiffy counters, not utilization, so a percentage
only exists between two readings: the share of elapsed jiffies that were not
idle. The derivation lives server-side with the other fleet judgments - the
browser gets percentages, never counters.
"""

from datetime import datetime
from itertools import pairwise

from fleet_monitor.probes.proc import CPU_FIELDS

# The busy series carries one point per collector tick, so a long window is
# thousands of them per host: a week at the vitals cadence is 20k points no
# chart can draw and no browser wants to parse. Anything longer than this is
# bucketed down instead.
MAX_POINTS = 720

# What the busy derivation reads back: exactly the aggregate-row metrics
# parse_stat writes, named from the same field list so the two cannot drift.
METRICS = tuple(f"cpu.total.{field}" for field in CPU_FIELDS)

# iowait counts as not-busy alongside idle: it is time the CPU spent waiting
# for the disks, and counting it as busy would paint a disk-bound NAS as
# compute-bound.
_IDLE_METRICS = frozenset({"cpu.total.idle", "cpu.total.iowait"})

Series = tuple[tuple[datetime, float], ...]

# One reading of the aggregate row: when it was taken, the sum of every field
# it carried, the not-busy share of that sum, and how many fields went into it.
_Tick = tuple[datetime, float, float, int]


def _ticks(series_by_metric: dict[str, Series]) -> tuple[_Tick, ...]:
    """Pivot per-metric series into per-timestamp jiffy sums.

    A timestamp with no idle reading is excluded outright: without idle there
    is no not-busy share to subtract, so the tick cannot be judged and the
    series bridges across it instead.
    """
    totals: dict[datetime, float] = {}
    idles: dict[datetime, float] = {}
    fields: dict[datetime, int] = {}
    for metric, points in series_by_metric.items():
        for at, value in points:
            totals[at] = totals.get(at, 0.0) + value
            fields[at] = fields.get(at, 0) + 1
            if metric in _IDLE_METRICS:
                idles[at] = idles.get(at, 0.0) + value
    return tuple(
        (at, totals[at], idles[at], fields[at]) for at in sorted(totals) if at in idles
    )


def _busy_percent(previous: _Tick, current: _Tick) -> float | None:
    """Busy percent across one pair of ticks, or None when the pair is
    unusable.

    Three ways a pair lies and is dropped instead: a counter that went
    backwards (a reboot zeroed /proc/stat - rendered anyway it would be a
    spike that never happened), no elapsed jiffies at all, and a tick that
    recorded a different set of fields than its neighbor, which skews the
    total delta by whatever the missing counters advanced.
    """
    (_, previous_total, previous_idle, previous_fields) = previous
    (_, current_total, current_idle, current_fields) = current
    delta_total = current_total - previous_total
    delta_idle = current_idle - previous_idle
    if previous_fields != current_fields:
        return None
    if delta_total <= 0 or delta_idle < 0 or delta_idle > delta_total:
        return None
    return round(100.0 * (1.0 - delta_idle / delta_total), 1)


def busy_series(series_by_metric: dict[str, Series]) -> Series:
    """The aggregate busy-percent series behind one host's cpu.total counters.

    Each point is stamped at the later reading of its pair and describes the
    interval since the earlier one. Unusable pairs are dropped, not
    interpolated: this is a monitor, and a gap is the honest rendering of a
    gap.
    """
    ticks = _ticks(series_by_metric)
    computed = (
        (current[0], _busy_percent(previous, current))
        for previous, current in pairwise(ticks)
    )
    return tuple((at, value) for at, value in computed if value is not None)


def downsample(
    series: Series,
    *,
    since: datetime,
    until: datetime,
    max_points: int = MAX_POINTS,
) -> Series:
    """The series thinned to at most `max_points` by averaging over fixed
    buckets. Returned unchanged when it is already short enough.

    Each bucket keeps the timestamp of its own last reading rather than a
    bucket edge, so every point still names a moment the host was really read,
    and the value stays what the raw points are: the busy share of the interval
    ending there. An empty bucket contributes nothing, so a hole longer than a
    bucket survives as a hole rather than being averaged over - a shorter one
    does not, which is the trade a week-wide view makes for being drawable at
    all.
    """
    if len(series) <= max_points:
        return series
    width = max((until - since).total_seconds() / max_points, 1.0)
    buckets: dict[int, list[tuple[datetime, float]]] = {}
    for at, value in series:
        index = int((at - since).total_seconds() // width)
        buckets.setdefault(index, []).append((at, value))
    return tuple(
        (points[-1][0], round(sum(value for _, value in points) / len(points), 1))
        for _, points in sorted(buckets.items())
    )
