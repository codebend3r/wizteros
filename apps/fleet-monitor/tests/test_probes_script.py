import re
from pathlib import Path

from fleet_monitor.probes import proc, script

FIXTURES = Path(__file__).parent / "fixtures"


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


def test_split_sections_is_line_anchored_sentinel():
    # Sentinels mid-line in a body must not be treated as section boundaries.
    # This guards against Docker container names or other values containing ###.
    text = "###stat\nvalue###middle\nmore data\n###meminfo\nMemTotal: 1 kB\n"
    sections = script.split_sections(text)

    assert sections["stat"] == "value###middle\nmore data\n"
    assert sections["meminfo"] == "MemTotal: 1 kB\n"
    assert len(sections) == 2


def test_vitals_script_captures_all_meminfo_keys():
    # Derive the head count from VITALS_SCRIPT and apply it to a real kernel's
    # /proc/meminfo, captured from caraxes. A synthetic meminfo would encode
    # the very assumption under test - its own key ordering - so only a real
    # one is evidence that `head -n N` reaches SwapTotal and SwapFree.
    match = re.search(r"head -n (\d+) /proc/meminfo", script.VITALS_SCRIPT)
    assert match, "meminfo head command not found in VITALS_SCRIPT"
    head_count = int(match.group(1))

    real_meminfo = (FIXTURES / "caraxes_proc_meminfo.txt").read_text().splitlines()
    assert len(real_meminfo) >= head_count, "fixture is shorter than the head count"
    captured_meminfo = "\n".join(real_meminfo[:head_count])

    # All keys from proc._MEM_KEYS must be present in the captured lines
    for key in proc._MEM_KEYS:
        assert key in captured_meminfo, (
            f"'{key}' from proc._MEM_KEYS not reachable within "
            f"head -n {head_count} in VITALS_SCRIPT"
        )
