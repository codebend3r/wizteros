from pathlib import Path

from fleet_monitor.probes import proc

FIXTURES = Path(__file__).parent / "fixtures"


def _by_metric(samples):
    return {s.metric: s.value for s in samples}


def test_parse_stat_emits_per_core_and_total_counters():
    text = (FIXTURES / "caraxes_proc_stat.txt").read_text()
    got = _by_metric(proc.parse_stat(text))

    assert got["cpu.total.user"] == 31815.0
    assert got["cpu.total.idle"] == 682370.0
    assert got["cpu.total.iowait"] == 11506.0
    assert got["cpu0.user"] == 8189.0
    assert got["cpu3.idle"] == 171007.0
    # 5 cpu lines x 8 tracked fields
    assert len(proc.parse_stat(text)) == 40
    assert all(s.kind == "counter" for s in proc.parse_stat(text))


def test_parse_meminfo_converts_kb_to_bytes():
    text = (FIXTURES / "caraxes_proc_meminfo.txt").read_text()
    got = _by_metric(proc.parse_meminfo(text))

    assert got["mem.total_bytes"] == 1683776 * 1024
    assert got["mem.available_bytes"] == 605812 * 1024
    assert got["mem.cached_bytes"] == 624132 * 1024
    # swap sits at lines 15 and 16 of a real aarch64 /proc/meminfo, which is
    # exactly what `head -n 16` in VITALS_SCRIPT is sized for
    assert got["mem.swap_total_bytes"] == 2097084 * 1024
    assert got["mem.swap_free_bytes"] == 2094876 * 1024
    assert all(s.kind == "gauge" for s in proc.parse_meminfo(text))


def test_parse_net_dev_skips_loopback_and_tunnels():
    text = (FIXTURES / "caraxes_proc_net_dev.txt").read_text()
    got = _by_metric(proc.parse_net_dev(text))

    assert got["net.eth1.rx_bytes"] == 15298811.0
    assert got["net.eth1.tx_bytes"] == 12733181.0
    assert "net.lo.rx_bytes" not in got
    assert "net.sit0.rx_bytes" not in got


def test_parse_net_dev_skips_docker_bridges():
    # vermithor carries 11 docker* interfaces; they are noise, not fleet traffic
    text = (
        "Inter-|   Receive  |  Transmit\n"
        " face |bytes ...\n"
        "  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n"
        "  docker0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n"
        "  docker41a7c36: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n"
    )
    got = _by_metric(proc.parse_net_dev(text))

    assert got == {"net.eth0.rx_bytes": 100.0, "net.eth0.tx_bytes": 200.0}


def test_parse_net_dev_skips_per_container_interfaces():
    # every running container creates a veth<hex> whose name changes on every
    # restart, so each one is written exactly once and never again. Sampling
    # them pins the oldest-metric age of a healthy docker host at "forever".
    text = (
        "Inter-|   Receive  |  Transmit\n"
        " face |bytes ...\n"
        "  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n"
        "  veth8a3f21: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n"
        "  br-1f2e3d4c5b6a: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n"
    )
    got = _by_metric(proc.parse_net_dev(text))

    assert got == {"net.eth0.rx_bytes": 100.0, "net.eth0.tx_bytes": 200.0}


def test_parse_loadavg():
    got = _by_metric(proc.parse_loadavg("0.20 0.18 0.12 1/721 21708\n"))

    assert got["load.1m"] == 0.20
    assert got["load.5m"] == 0.18
    assert got["load.15m"] == 0.12
    assert got["procs.running"] == 1.0
    assert got["procs.total"] == 721.0


def test_parse_uptime():
    got = _by_metric(proc.parse_uptime("950412.67 3698765.43\n"))

    assert got["uptime.seconds"] == 950412.67


def test_parsers_skip_non_numeric_values_instead_of_raising():
    # /proc is read over ssh and arrives as unvalidated text; one malformed
    # token reaching float() raises out of the parser and costs the whole
    # host's round
    stat = _by_metric(proc.parse_stat("cpu  100 nan 50 900 0 0 0 0\ncpu0 x y z\n"))
    assert stat["cpu.total.user"] == 100.0
    assert "cpu.total.nice" not in stat
    assert stat["cpu.total.system"] == 50.0
    assert not any(metric.startswith("cpu0.") for metric in stat)

    assert proc.parse_meminfo("MemTotal:  not-a-number kB\n") == ()
    assert proc.parse_net_dev("h1\nh2\n  eth0: x 1 0 0 0 0 0 0 y 2 0 0 0 0 0 0\n") == ()
    assert proc.parse_loadavg("0.20 nope 0.12 1/721 21708\n") == ()
    assert proc.parse_uptime("not-a-number 3698765.43\n") == ()


def test_parsers_are_total_on_empty_input():
    # a truncated tick must yield nothing, never raise: one bad host cannot
    # be allowed to kill a collection round
    assert proc.parse_stat("") == ()
    assert proc.parse_meminfo("") == ()
    assert proc.parse_net_dev("") == ()
    assert proc.parse_loadavg("") == ()
    assert proc.parse_uptime("") == ()
