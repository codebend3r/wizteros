from fleet_monitor.probes import system


def _by_metric(samples):
    return {s.metric: s.value for s in samples}


def test_parse_df_reports_bytes_and_percent():
    # df -Pk output; -P forces one line per filesystem even for long device names
    text = (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/mapper/cachedev_0 101815078912 99863519232 1951559680 99% /volume1\n"
    )
    got = _by_metric(system.parse_df(text))

    assert got["disk.volume1.total_bytes"] == 101815078912 * 1024
    assert got["disk.volume1.used_bytes"] == 99863519232 * 1024
    assert got["disk.volume1.available_bytes"] == 1951559680 * 1024
    assert got["disk.volume1.used_percent"] == 99.0


def test_parse_df_handles_the_lvm_and_crypt_device_names():
    # caraxes uses /dev/vg1/volume_1 and meleys uses /dev/mapper/cryptvol_1
    text = (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/vg1/volume_1 28991029248 24696061952 3652116480 88% /volume1\n"
    )
    got = _by_metric(system.parse_df(text))

    assert got["disk.volume1.used_percent"] == 88.0


def test_parse_hwmon_reads_millidegrees():
    # the collector emits one "name=<chip> <label>=<millidegrees>" line per sensor
    text = "coretemp temp1_input=41000\ncoretemp temp2_input=39000\n"
    got = _by_metric(system.parse_hwmon(text))

    assert got["temp.coretemp.temp1"] == 41.0
    assert got["temp.coretemp.temp2"] == 39.0


def test_parse_gpu_freq_emits_ratio():
    # vermithor and vhagar idle at 100 MHz against a 750 MHz ceiling
    got = _by_metric(system.parse_gpu_freq("100\n750\n"))

    assert got["gpu.freq_mhz"] == 100.0
    assert got["gpu.freq_max_mhz"] == 750.0
    assert got["gpu.freq_ratio"] == 100.0 / 750.0


def test_parse_gpu_freq_absent_on_boxes_without_a_render_node():
    # meleys, syrax and caraxes have no /dev/dri, so the script emits nothing
    assert system.parse_gpu_freq("") == ()


def test_parse_gpu_freq_survives_a_zero_ceiling():
    assert _by_metric(system.parse_gpu_freq("0\n0\n")).get("gpu.freq_ratio") is None


def test_parse_inotify_reports_ceilings_and_usage():
    # both docker hosts sit at 262144 watches after the 2026-08-08 raise
    text = "max_user_watches=262144\nmax_user_instances=1024\ninstances_in_use=37\n"
    got = _by_metric(system.parse_inotify(text))

    assert got["inotify.max_user_watches"] == 262144.0
    assert got["inotify.max_user_instances"] == 1024.0
    assert got["inotify.instances_in_use"] == 37.0
    assert got["inotify.instances_used_ratio"] == 37.0 / 1024.0


def test_parse_inotify_skips_an_unreadable_value():
    # cat failing leaves the key with an empty value, which must not become 0
    got = _by_metric(system.parse_inotify("max_user_watches=\nmax_user_instances=1024\n"))

    assert "inotify.max_user_watches" not in got
    assert got["inotify.max_user_instances"] == 1024.0


def test_system_parsers_are_total_on_empty_input():
    assert system.parse_df("") == ()
    assert system.parse_hwmon("") == ()
    assert system.parse_inotify("") == ()


def test_parse_df_skips_rows_with_non_numeric_usage():
    # tmpfs and proc filesystems often report - for capacity/usage columns
    text = (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/mapper/good_fs 1000000 500000 500000 50% /volume1\n"
        "tmpfs 1000000 - - - /run\n"
        "/dev/mapper/another_good 2000000 1000000 1000000 50% /volume2\n"
    )
    got = _by_metric(system.parse_df(text))

    # Good rows parse, bad row with dashes is silently skipped
    assert got["disk.volume1.used_percent"] == 50.0
    assert got["disk.volume2.used_percent"] == 50.0
    assert "disk.run.used_percent" not in got


def test_parse_gpu_freq_returns_empty_on_non_numeric_multi_token_input():
    # transient cat error with multiple tokens (e.g. cat: read error)
    assert system.parse_gpu_freq("cat: read error\n") == ()
    assert system.parse_gpu_freq("abc def\n") == ()
