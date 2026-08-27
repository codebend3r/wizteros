"""Every chartable history the dashboard draws, as one shape.

Four questions, four different pieces of arithmetic: CPU busy comes out of
jiffy counters, memory out of two gauges read against each other, GPU out of a
frequency ratio, network out of byte counters. The page draws all four the same
way, so they leave here as the same thing - a per-host series of (moment,
value), plus a unit naming what the numbers mean.

The derivations live here rather than in the browser for the same reason the
host judgments do: they need to know what the collector collects. Which volume
is watched, which meminfo keys carry the truth about used memory, that a GPU
frequency is a load proxy and not a utilization percent - none of that is
knowable a wire away.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fleet_monitor import cpu, store
from fleet_monitor.store import Series

# A series carries one point per collector tick, so a long window is thousands
# of them per host: a week at the vitals cadence is 20k points no chart can draw
# and no browser wants to parse. Anything longer than this is bucketed down.
MAX_POINTS = 720

# Memory is judged against MemAvailable rather than MemFree: free excludes
# reclaimable page cache, and on these boxes that reads as 95% used on an idle
# machine. Both keys are what probes.proc writes, named from there.
MEMORY_TOTAL_METRIC = "mem.total_bytes"
MEMORY_AVAILABLE_METRIC = "mem.available_bytes"

# The i915 actual-frequency share of the card's ceiling. DSM ships no
# intel_gpu_top and does not expose the i915 perf interface, so a true busy
# percentage is not obtainable on this fleet; this is a load proxy and the page
# has to say so rather than print it as utilization.
GPU_RATIO_METRIC = "gpu.freq_ratio"

# Every per-interface byte counter probes.proc kept - loopback, tunnels, the
# docker bridges and the veth pairs are already dropped there, so what remains
# is the physical NICs. Measured 2026-08-26: meleys has eth0/eth1/eth2,
# vermithor and vhagar eth0/eth1, and none of the five runs a bond, so summing
# every interface cannot double-count a bond against its own members.
NETWORK_PREFIX = "net."

Unit = Literal["percent", "bytes_per_second"]

Kind = Literal["cpu", "memory", "gpu", "network"]


@dataclass(frozen=True, slots=True)
class Family:
    """One chartable metric family: what to read, and how to reduce it.

    `metrics` names the members when they are known ahead of time; `prefix`
    discovers them per host instead, for a family whose membership is a
    property of the box rather than of this code.
    """

    kind: Kind
    unit: Unit
    metrics: tuple[str, ...]
    prefix: str
    derive: Callable[[dict[str, Series]], Series]


def memory_used_series(series_by_metric: dict[str, Series]) -> Series:
    """Used memory as a percentage, per tick.

    Both gauges come from one /proc/meminfo read, so they share a timestamp; a
    moment carrying only one of them cannot be judged and is dropped rather
    than paired with a neighbouring reading. A total of zero is not a full
    machine, it is a bad read, and goes the same way.
    """
    totals = dict(series_by_metric.get(MEMORY_TOTAL_METRIC, ()))
    available = dict(series_by_metric.get(MEMORY_AVAILABLE_METRIC, ()))
    return tuple(
        (at, round((total - free) / total * 100.0, 1))
        for at, total in sorted(totals.items())
        if total > 0
        for free in (available.get(at),)
        if free is not None and 0.0 <= free <= total
    )


def gpu_load_series(series_by_metric: dict[str, Series]) -> Series:
    """The GPU's frequency share of its own ceiling, as a percentage.

    Not utilization. A card can sit at its floor frequency while busy and at
    its ceiling while barely working, so this says how hard the card is being
    clocked, which is the only GPU signal these boxes expose.

    Clamped at the top rather than dropped: a card reporting above its own
    stated maximum is pegged, and rendering that as a missing reading would
    hide the one moment worth seeing. Below zero is not a reading at all.
    """
    return tuple(
        (at, round(min(ratio, 1.0) * 100.0, 1))
        for at, ratio in series_by_metric.get(GPU_RATIO_METRIC, ())
        if ratio >= 0.0
    )


def network_throughput_series(series_by_metric: dict[str, Series]) -> Series:
    """Total bytes per second across every interface, received plus sent.

    Counters become rates through `store.rate_series`, which drops the pair
    either side of a reboot rather than rendering the reset as a spike. Every
    interface is read from one /proc/net/dev per tick, so the per-interface
    rates share timestamps and sum cleanly.

    An interface that appears or disappears mid-window changes what the sum
    covers, which is a real change in what the box has rather than an artifact
    to correct for. A veth would be the exception, and those never reach here:
    probes.proc drops them before they are ever stored.
    """
    totals: dict[datetime, float] = {}
    for points in series_by_metric.values():
        for at, value in store.rate_series(points):
            totals[at] = totals.get(at, 0.0) + value
    return tuple((at, round(totals[at], 1)) for at in sorted(totals))


FAMILIES: dict[str, Family] = {
    "cpu": Family(
        kind="cpu",
        unit="percent",
        metrics=cpu.METRICS,
        prefix="",
        derive=cpu.busy_series,
    ),
    "memory": Family(
        kind="memory",
        unit="percent",
        metrics=(MEMORY_TOTAL_METRIC, MEMORY_AVAILABLE_METRIC),
        prefix="",
        derive=memory_used_series,
    ),
    "gpu": Family(
        kind="gpu",
        unit="percent",
        metrics=(GPU_RATIO_METRIC,),
        prefix="",
        derive=gpu_load_series,
    ),
    "network": Family(
        kind="network",
        unit="bytes_per_second",
        metrics=(),
        prefix=NETWORK_PREFIX,
        derive=network_throughput_series,
    ),
}


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
    and the value stays what the raw points are: the reading for the interval
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


def history(
    connection,
    *,
    family: Family,
    target: str,
    since: datetime,
    until: datetime,
) -> Series:
    """One target's series for one family, derived and thinned to fit a chart.

    A target that reported none of the family's metrics comes back empty rather
    than as zeros: three of the five boxes have no render node at all, and a
    flat line along the axis would claim an idle GPU where there is no GPU.
    """
    raw = (
        store.metric_series_prefix(connection, target, family.prefix, since=since)
        if family.prefix
        else store.metric_series(connection, target, family.metrics, since=since)
    )
    return downsample(family.derive(raw), since=since, until=until)
