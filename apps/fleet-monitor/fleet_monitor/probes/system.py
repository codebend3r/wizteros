from fleet_monitor.probes.types import Sample

_BLOCK_BYTES = 1024


def parse_df(text: str) -> tuple[Sample, ...]:
    """Volume usage from `df -Pk <mount>`.

    -P is required: without it df wraps long device names onto a second line,
    and the fleet runs three different naming schemes (/dev/mapper/cachedev_0,
    /dev/mapper/cryptvol_1, /dev/vg1/volume_1).
    """
    rows = [ln.split() for ln in text.splitlines()[1:] if ln.strip()]
    return tuple(
        sample
        for fields in rows
        if (len(fields) >= 6 and
            fields[1].lstrip("-").isdigit() and
            fields[2].lstrip("-").isdigit() and
            fields[3].lstrip("-").isdigit() and
            fields[4].rstrip("%").lstrip("-").isdigit())
        for name in (fields[5].lstrip("/").replace("/", "_") or "root",)
        for sample in (
            Sample(
                metric=f"disk.{name}.total_bytes",
                value=float(fields[1]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.used_bytes",
                value=float(fields[2]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.available_bytes",
                value=float(fields[3]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.used_percent",
                value=float(fields[4].rstrip("%")),
                kind="gauge",
            ),
        )
    )


def parse_hwmon(text: str) -> tuple[Sample, ...]:
    """Chip temperatures from lines shaped `<chip> <label>_input=<millidegrees>`.

    The collector flattens the hwmon tree into that shape because the sysfs
    layout differs across the fleet; only vermithor exposes a coretemp chip at
    hwmon0.
    """
    rows = [ln.split() for ln in text.splitlines() if "=" in ln]
    return tuple(
        Sample(
            metric=f"temp.{fields[0]}.{key.removesuffix('_input')}",
            value=float(raw) / 1000.0,
            kind="gauge",
        )
        for fields in rows
        if len(fields) >= 2
        for key, _, raw in (fields[1].partition("="),)
        if raw.lstrip("-").isdigit()
    )


def parse_inotify(text: str) -> tuple[Sample, ...]:
    """Inotify ceilings and instance usage from `key=value` lines.

    Tracked because meleys exhausted its watch limit once already (raised from
    8192 to 262144 on 2026-08-08). Running a second media server against the
    same libraries doubles the demand on the same ceiling, so the headroom is
    worth watching rather than rediscovering the hard way.
    """
    pairs = [line.split("=", 1) for line in text.splitlines() if "=" in line]
    values = {
        key: float(raw)
        for key, raw in pairs
        if raw.strip() and raw.strip().lstrip("-").isdigit()
    }
    base = tuple(
        Sample(metric=f"inotify.{key}", value=value, kind="gauge")
        for key, value in values.items()
    )
    ceiling = values.get("max_user_instances", 0.0)
    in_use = values.get("instances_in_use")
    if ceiling <= 0 or in_use is None:
        return base
    return (
        *base,
        Sample(metric="inotify.instances_used_ratio", value=in_use / ceiling, kind="gauge"),
    )


def parse_gpu_freq(text: str) -> tuple[Sample, ...]:
    """Intel i915 frequency from gt_act_freq_mhz and gt_max_freq_mhz.

    This is a load proxy, not a utilization percentage. DSM ships no
    intel_gpu_top and does not expose the i915 perf interface, so a true busy
    percentage is not obtainable.

    Only vermithor and vhagar have a render node at all. Verified 2026-08-11:
    meleys has no /dev/dri, an empty /sys/class/drm, and no amdgpu or radeon
    module loaded, because Synology does not enable the Vega iGPU on the
    R1600. That is a permanent property of the box, not a missing driver, so
    anything transcoding on meleys is doing it in software on 2 physical cores.
    """
    fields = text.split()
    if (len(fields) < 2 or
        not fields[0].lstrip("-").isdigit() or
        not fields[1].lstrip("-").isdigit()):
        return ()
    current, ceiling = float(fields[0]), float(fields[1])
    base = (
        Sample(metric="gpu.freq_mhz", value=current, kind="gauge"),
        Sample(metric="gpu.freq_max_mhz", value=ceiling, kind="gauge"),
    )
    if ceiling <= 0:
        return base
    return (*base, Sample(metric="gpu.freq_ratio", value=current / ceiling, kind="gauge"))
