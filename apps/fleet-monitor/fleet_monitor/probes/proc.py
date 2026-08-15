from fleet_monitor.probes.types import Sample

# /proc/stat orders these fields after the cpu label. Trailing guest fields are
# ignored: they are already counted inside user and nice.
_CPU_FIELDS = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")

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
            value=float(row[index + 1]),
            kind="counter",
        )
        for row in rows
        for index, field in enumerate(_CPU_FIELDS)
        if index + 1 < len(row)
    )


def parse_meminfo(text: str) -> tuple[Sample, ...]:
    """Memory gauges from /proc/meminfo, converted from kB to bytes."""
    rows = (ln.split(":", 1) for ln in text.splitlines() if ":" in ln)
    return tuple(
        Sample(metric=_MEM_KEYS[key], value=float(rest.split()[0]) * 1024, kind="gauge")
        for key, rest in rows
        if key in _MEM_KEYS and rest.split()
    )


def parse_net_dev(text: str) -> tuple[Sample, ...]:
    """Per-interface byte counters, minus loopback, tunnels and docker bridges.

    The docker* bridges are skipped because vermithor alone carries eleven of
    them and none of them describe traffic entering or leaving the box.
    """
    body = text.splitlines()[2:]
    rows = [ln.split(":", 1) for ln in body if ":" in ln]
    named = [(name.strip(), rest.split()) for name, rest in rows]
    return tuple(
        sample
        for name, fields in named
        if name not in _SKIP_IFACES
        and not name.startswith("docker")
        and len(fields) > _TX_BYTES
        for sample in (
            Sample(metric=f"net.{name}.rx_bytes", value=float(fields[_RX_BYTES]), kind="counter"),
            Sample(metric=f"net.{name}.tx_bytes", value=float(fields[_TX_BYTES]), kind="counter"),
        )
    )


def parse_loadavg(text: str) -> tuple[Sample, ...]:
    """Load averages and the runnable/total process counts from /proc/loadavg."""
    fields = text.split()
    if len(fields) < 4 or "/" not in fields[3]:
        return ()
    running, total = fields[3].split("/", 1)
    return (
        Sample(metric="load.1m", value=float(fields[0]), kind="gauge"),
        Sample(metric="load.5m", value=float(fields[1]), kind="gauge"),
        Sample(metric="load.15m", value=float(fields[2]), kind="gauge"),
        Sample(metric="procs.running", value=float(running), kind="gauge"),
        Sample(metric="procs.total", value=float(total), kind="gauge"),
    )


def parse_uptime(text: str) -> tuple[Sample, ...]:
    """Seconds since boot from /proc/uptime.

    Read from /proc rather than the uptime command because the DSM uptime
    output carries Synology's own IO and CPU suffixes, which shift the columns.
    """
    fields = text.split()
    if not fields:
        return ()
    return (Sample(metric="uptime.seconds", value=float(fields[0]), kind="gauge"),)
