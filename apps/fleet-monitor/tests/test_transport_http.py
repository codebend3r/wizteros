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
