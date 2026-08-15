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


def test_parsers_are_total_on_empty_input():
    # a truncated tick must yield nothing, never raise: one bad host cannot
    # be allowed to kill a collection round
    assert proc.parse_stat("") == ()
    assert proc.parse_meminfo("") == ()
    assert proc.parse_net_dev("") == ()
    assert proc.parse_loadavg("") == ()
    assert proc.parse_uptime("") == ()
