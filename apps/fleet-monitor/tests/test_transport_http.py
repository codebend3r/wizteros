from fleet_monitor.transport import http


async def test_get_json_returns_a_typed_failure_for_a_dead_port():
    # port 1 on localhost refuses; the collector must degrade, not raise
    result = await http.get_json("http://127.0.0.1:1/containers/json", timeout=2.0)

    assert result.ok is False
    assert result.reason in {"refused", "timeout", "transport_error"}
    assert result.status == 0


async def test_get_json_reports_a_bad_url_as_a_typed_failure():
    result = await http.get_json("http://nonexistent.invalid/x", timeout=2.0)

    assert result.ok is False
    assert result.reason in {"dns", "timeout", "transport_error"}


async def test_get_json_accepts_a_verify_switch_for_self_signed_servers():
    # two Plex servers present the *.plex.direct wildcard on a LAN ip, which
    # cannot verify; the switch has to exist, and it must not change the
    # never-raises contract
    result = await http.get_json("https://127.0.0.1:1/identity", timeout=2.0, verify=False)

    assert result.ok is False
    assert result.reason in {"refused", "timeout", "transport_error"}
