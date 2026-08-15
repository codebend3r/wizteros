from fleet_monitor.probes import script


def test_split_sections_keys_by_sentinel():
    text = "###stat\ncpu 1 2 3\n###meminfo\nMemTotal: 4 kB\n"
    assert script.split_sections(text) == {
        "stat": "cpu 1 2 3\n",
        "meminfo": "MemTotal: 4 kB\n",
    }


def test_split_sections_ignores_preamble_before_the_first_sentinel():
    # a login banner or an ssh warning that slipped past LogLevel=ERROR
    text = "warning: something\n###stat\ncpu 1 2 3\n"
    assert script.split_sections(text) == {"stat": "cpu 1 2 3\n"}


def test_split_sections_keeps_an_empty_section_empty():
    # a host with no render node emits the gpu sentinel with nothing under it,
    # which must read as "collected, nothing there", not as a missing section
    text = "###stat\ncpu 1 2 3\n###gpu\n###loadavg\n0.1 0.2 0.3 1/2 3\n"
    sections = script.split_sections(text)

    assert sections["gpu"] == ""
    assert "gpu" in sections


def test_split_sections_on_empty_input():
    assert script.split_sections("") == {}


def test_vitals_script_covers_every_vitals_source():
    assert "###stat" in script.VITALS_SCRIPT
    assert "/proc/stat" in script.VITALS_SCRIPT
    assert "###meminfo" in script.VITALS_SCRIPT
    assert "###netdev" in script.VITALS_SCRIPT
    assert "###loadavg" in script.VITALS_SCRIPT
    assert "###uptime" in script.VITALS_SCRIPT


def test_vitals_script_tolerates_a_missing_render_node():
    # the gpu read must not fail the script on the three boxes without /dev/dri
    assert "gt_act_freq_mhz" in script.VITALS_SCRIPT
    assert "2>/dev/null" in script.VITALS_SCRIPT


def test_slow_script_covers_disk_and_temperature():
    assert "###df" in script.SLOW_SCRIPT
    assert "df -Pk" in script.SLOW_SCRIPT
    assert "###hwmon" in script.SLOW_SCRIPT


def test_slow_script_reads_inotify_headroom():
    # meleys ran out of inotify watches once already; a second media server
    # scanning the same libraries doubles the demand, so track the ceiling
    assert "###inotify" in script.SLOW_SCRIPT
    assert "max_user_watches" in script.SLOW_SCRIPT
    assert "max_user_instances" in script.SLOW_SCRIPT


def test_scripts_do_not_use_set_e():
    # a missing optional source must not abort the remaining sections
    assert "set -e" not in script.VITALS_SCRIPT
    assert "set -e" not in script.SLOW_SCRIPT
