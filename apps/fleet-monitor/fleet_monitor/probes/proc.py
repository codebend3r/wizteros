from fleet_monitor.probes.parse import number
from fleet_monitor.probes.types import Sample

# /proc/stat orders these fields after the cpu label. Trailing guest fields are
# ignored: they are already counted inside user and nice. Public because cpu.py
# derives the metric names it reads back from this same list: what the busy
# derivation sums is defined by what parse_stat writes, in one place.
CPU_FIELDS = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")

# Values are in kB. Anything not listed here is not worth a row per tick.
_MEM_KEYS = {
    "MemTotal": "mem.total_bytes",
    "MemFree": "mem.free_bytes",
    "MemAvailable": "mem.available_bytes",
    "Buffers": "mem.buffers_bytes",
    "Cached": "mem.cached_bytes",
    "SwapTotal": "mem.swap_total_bytes",
    "SwapFree": "mem.swap_free_bytes",
}

_SKIP_IFACES = frozenset({"lo", "sit0"})

# Per-container and bridge interfaces. veth is the one that matters: every
# running container creates a veth<hex> whose name changes on every restart, so
# each one is written exactly once and never again. Kept out of the samples
# entirely, because a metric that stops being produced the moment it appears
# poisons every staleness signal derived from metric timestamps.
_SKIP_PREFIXES = ("docker", "veth", "br-")

# Byte columns in /proc/net/dev after the interface name: receive starts at 0,
# transmit at 8 (each half is bytes packets errs drop fifo frame compressed
# multicast).
_RX_BYTES = 0
_TX_BYTES = 8


def parse_stat(text: str) -> tuple[Sample, ...]:
    """Per-core and aggregate CPU jiffy counters from /proc/stat."""
    rows = [ln.split() for ln in text.splitlines() if ln.startswith("cpu")]
    return tuple(
        Sample(
            metric=f"{'cpu.total' if row[0] == 'cpu' else row[0]}.{field}",
            value=value,
            kind="counter",
        )
        for row in rows
        for index, field in enumerate(CPU_FIELDS)
        if index + 1 < len(row)
        for value in (number(row[index + 1]),)
        if value is not None
    )


def parse_meminfo(text: str) -> tuple[Sample, ...]:
    """Memory gauges from /proc/meminfo, converted from kB to bytes."""
    rows = (ln.split(":", 1) for ln in text.splitlines() if ":" in ln)
    return tuple(
        Sample(metric=_MEM_KEYS[key], value=kilobytes * 1024, kind="gauge")
        for key, rest in rows
        if key in _MEM_KEYS and rest.split()
        for kilobytes in (number(rest.split()[0]),)
        if kilobytes is not None
    )


def parse_net_dev(text: str) -> tuple[Sample, ...]:
    """Per-interface byte counters, minus loopback, tunnels and container
    plumbing.

    The docker* bridges are skipped because vermithor alone carries eleven of
    them and none of them describe traffic entering or leaving the box. veth*
    and br-* go with them: they are per-container, and a veth name changes on
    every container restart.
    """
    body = text.splitlines()[2:]
    rows = [ln.split(":", 1) for ln in body if ":" in ln]
    named = [(name.strip(), rest.split()) for name, rest in rows]
    return tuple(
        sample
        for name, fields in named
        if name not in _SKIP_IFACES
        and not name.startswith(_SKIP_PREFIXES)
        and len(fields) > _TX_BYTES
        for received, sent in ((number(fields[_RX_BYTES]), number(fields[_TX_BYTES])),)
        if received is not None and sent is not None
        for sample in (
            Sample(metric=f"net.{name}.rx_bytes", value=received, kind="counter"),
            Sample(metric=f"net.{name}.tx_bytes", value=sent, kind="counter"),
        )
    )


def parse_loadavg(text: str) -> tuple[Sample, ...]:
    """Load averages and the runnable/total process counts from /proc/loadavg."""
    fields = text.split()
    if len(fields) < 4 or "/" not in fields[3]:
        return ()
    running, total = fields[3].split("/", 1)
    values = tuple(number(token) for token in (*fields[:3], running, total))
    # one malformed column makes the whole line untrustworthy: it is a single
    # reading of one file, not five independent ones
    if any(value is None for value in values):
        return ()
    metrics = ("load.1m", "load.5m", "load.15m", "procs.running", "procs.total")
    return tuple(
        Sample(metric=metric, value=value, kind="gauge")
        for metric, value in zip(metrics, values, strict=True)
    )


def parse_uptime(text: str) -> tuple[Sample, ...]:
    """Seconds since boot from /proc/uptime.

    Read from /proc rather than the uptime command because the DSM uptime
    output carries Synology's own IO and CPU suffixes, which shift the columns.
    """
    fields = text.split()
    seconds = number(fields[0]) if fields else None
    if seconds is None:
        return ()
    return (Sample(metric="uptime.seconds", value=seconds, kind="gauge"),)
