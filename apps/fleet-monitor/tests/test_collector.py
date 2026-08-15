import json
from datetime import datetime, timedelta, timezone

from fleet_monitor import collector, config, incidents, store
from fleet_monitor.transport.http import HttpResult
from fleet_monitor.transport.ssh import SshResult

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)

SECTIONS = {
    "stat": "cpu  100 0 50 900 0 0 0 0 0 0\n",
    "meminfo": "MemTotal:  1683776 kB\nMemAvailable: 741756 kB\n",
    "netdev": "h1\nh2\n  eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0\n",
    "loadavg": "0.20 0.18 0.12 1/721 21708\n",
    "uptime": "950412.67 3698765.43\n",
    "gpu": "",
}

SLOW_SECTIONS = {
    "df": (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/mapper/cachedev_0 100 40 60 40% /volume1\n"
    ),
}

# The docker host used by every container test. Its url is deliberately
# unresolvable: every test fakes the transport, so a leaked real request fails
# loudly instead of touching the LAN.
DOCKER_HOST = config.Host(
    name="meleys", ip="192.0.2.2", has_gpu=False, docker_url="http://proxy.invalid:2375"
)


def _stdout(sections: dict[str, str]) -> str:
    """Re-assemble a sections dict into the sentinel-delimited wire format."""
    return "".join(f"###{name}\n{body}" for name, body in sections.items())


def _db(tmp_path) -> str:
    path = str(tmp_path / "fleet.db")
    store.init_db(path)
    incidents.init_db(path)
    return path


def _fake_ssh(result: SshResult):
    """An ssh.run replacement that answers every host with one canned result."""

    async def _run(host, body, **kwargs):
        return result

    return _run


def _fake_http(result: HttpResult):
    """A http.get_json replacement that answers every url with one result."""

    async def _get_json(url, **kwargs):
        return result

    return _get_json


def _entry(name: str, *, state: str = "running", status: str = "Up 2 days") -> dict:
    return {"Names": [f"/{name}"], "State": state, "Status": status}


def _docker_ok(*entries: dict) -> HttpResult:
    return HttpResult(ok=True, status=200, body=json.dumps(list(entries)), reason="")


DOCKER_REFUSED = HttpResult(ok=False, status=0, body="", reason="refused")


def _targets(checks) -> set[str]:
    return {check.target for check in checks}


def _open_targets(db: str) -> set[str]:
    return {row["target"] for row in incidents.open_incidents(db)}


def test_samples_from_sections_merges_every_parser():
    got = {s.metric for s in collector.samples_from_sections(SECTIONS)}

    assert "cpu.total.user" in got
    assert "mem.total_bytes" in got
    assert "net.eth0.rx_bytes" in got
    assert "load.1m" in got
    assert "uptime.seconds" in got


def test_samples_from_sections_skips_a_missing_section():
    # a truncated response must still yield whatever did arrive
    got = {s.metric for s in collector.samples_from_sections({"loadavg": "0.1 0.2 0.3 1/2 3\n"})}

    assert got == {"load.1m", "load.5m", "load.15m", "procs.running", "procs.total"}


def test_samples_from_sections_on_an_empty_response():
    assert collector.samples_from_sections({}) == ()


def test_samples_from_sections_covers_the_slow_tier_sections():
    got = {s.metric for s in collector.samples_from_sections(SLOW_SECTIONS)}

    assert "disk.volume1.used_percent" in got


def test_samples_from_sections_keeps_an_empty_section_empty():
    # "collected, nothing there" is not an error, and it is not a sample either
    assert collector.samples_from_sections({"gpu": ""}) == ()


async def test_collect_host_records_a_failure_for_an_unroutable_ip(tmp_path, monkeypatch):
    # faked at the transport seam rather than spawning a real ssh at 192.0.2.1:
    # no test in this package may leave the process
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=False, stdout="", reason="unreachable"))
    )
    host = config.Host(name="ghost", ip="192.0.2.1", has_gpu=False, docker_url="")

    result = await collector.collect_host(host, T0, db, timeout=2)

    assert result.ok is False
    assert result.target == "host:ghost"
    assert result.reason != ""
    # nothing collected must not look like a healthy empty host
    assert store.latest(db, "host:ghost") == {}


async def test_collect_host_writes_samples_on_success(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=True, stdout=_stdout(SECTIONS), reason=""))
    )

    result = await collector.collect_host(DOCKER_HOST, T0, db)

    assert result == incidents.CheckResult(target="host:meleys", ok=True, reason="")
    assert store.latest(db, "host:meleys")["load.1m"] == 0.20


async def test_collect_host_writes_no_samples_when_ssh_fails(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=False, stdout="", reason="timeout"))
    )

    result = await collector.collect_host(DOCKER_HOST, T0, db)

    assert result.ok is False
    assert result.reason == "timeout"
    assert store.latest(db, "host:meleys") == {}


async def test_collect_host_stamps_an_aware_utc_timestamp(tmp_path, monkeypatch):
    # store round-trips through isoformat(); a naive stamp silently changes the
    # stored string and breaks every comparison downstream
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=True, stdout=_stdout(SECTIONS), reason=""))
    )

    await collector.collect_host(DOCKER_HOST, T0, db)
    points = store.series(db, "host:meleys", "load.1m", since=T0 - timedelta(minutes=1))

    assert len(points) == 1
    assert points[0][0] == T0
    assert points[0][0].tzinfo is not None


async def test_a_host_that_fails_ssh_opens_a_host_incident(tmp_path, monkeypatch):
    # the host itself was observed, so its failure is a real failed check and
    # must be recorded - unlike the containers behind an unreachable endpoint
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=False, stdout="", reason="unreachable"))
    )

    await collector.collect_host(DOCKER_HOST, T0, db)
    await collector.collect_host(DOCKER_HOST, T0 + timedelta(seconds=30), db)

    assert _open_targets(db) == {"host:meleys"}


async def test_collect_slow_writes_the_slow_tier_samples(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh,
        "run",
        _fake_ssh(SshResult(ok=True, stdout=_stdout(SLOW_SECTIONS), reason="")),
    )

    await collector.collect_slow(DOCKER_HOST, T0, db)

    assert store.latest(db, "host:meleys")["disk.volume1.used_percent"] == 40.0


async def test_collect_slow_never_folds_a_second_check_into_the_streak(tmp_path, monkeypatch):
    # the slow tier rides the same ssh path as vitals against the same host. If
    # it recorded its own check, one failed vitals round plus one failed slow
    # round at the same instant would reach the 2-failure threshold on their
    # own, halving the hysteresis that makes an incident mean something
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=False, stdout="", reason="timeout"))
    )

    await collector.collect_host(DOCKER_HOST, T0, db)
    await collector.collect_slow(DOCKER_HOST, T0, db)

    assert incidents.open_incidents(db) == ()


async def test_collect_slow_writes_nothing_when_ssh_fails(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=False, stdout="", reason="timeout"))
    )

    await collector.collect_slow(DOCKER_HOST, T0, db)

    assert store.latest(db, "host:meleys") == {}


async def test_collect_containers_is_a_no_op_without_a_docker_url(tmp_path):
    db = _db(tmp_path)
    host = config.Host(name="caraxes", ip="192.168.50.4", has_gpu=False, docker_url="")

    assert await collector.collect_containers(host, T0, db) == ()
    assert store.latest(db, "host:caraxes") == {}


async def test_collect_containers_checks_every_container(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http,
        "get_json",
        _fake_http(_docker_ok(_entry("sonarr"), _entry("radarr", state="exited", status="Exited"))),
    )

    checks = await collector.collect_containers(DOCKER_HOST, T0, db)
    by_target = {check.target: check for check in checks}

    assert set(by_target) == {
        "docker:meleys", "container:meleys/sonarr", "container:meleys/radarr"
    }
    assert by_target["docker:meleys"].ok is True
    assert by_target["container:meleys/sonarr"].ok is True
    assert by_target["container:meleys/radarr"].ok is False
    assert by_target["container:meleys/radarr"].reason == "not_running"
    assert store.latest(db, "host:meleys")["container.sonarr.up"] == 1.0


async def test_collect_containers_names_an_unhealthy_container(tmp_path, monkeypatch):
    # running but failing its healthcheck is a distinct reason from stopped;
    # an incident opened with an empty reason tells the operator nothing
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http,
        "get_json",
        _fake_http(_docker_ok(_entry("plex", status="Up 3 hours (unhealthy)"))),
    )

    checks = await collector.collect_containers(DOCKER_HOST, T0, db)
    by_target = {check.target: check for check in checks}

    assert by_target["container:meleys/plex"].ok is False
    assert by_target["container:meleys/plex"].reason == "unhealthy"


async def test_collect_containers_records_the_docker_endpoint_when_it_fails(tmp_path, monkeypatch):
    # the socket proxy is a target the collector really did observe, so its
    # failure is a real failed check
    db = _db(tmp_path)
    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))

    checks = await collector.collect_containers(DOCKER_HOST, T0, db)

    assert _targets(checks) == {"docker:meleys"}
    assert checks[0].ok is False
    assert checks[0].reason == "refused"


async def test_collect_containers_reports_bad_json_without_touching_containers(
    tmp_path, monkeypatch
):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http,
        "get_json",
        _fake_http(HttpResult(ok=True, status=200, body="<html>nope", reason="")),
    )

    checks = await collector.collect_containers(DOCKER_HOST, T0, db)

    assert _targets(checks) == {"docker:meleys"}
    assert checks[0].reason == "bad_json"


async def test_a_json_object_body_is_not_an_empty_fleet(tmp_path, monkeypatch):
    # a socket proxy answering 200 {"message": "page not found"} is valid JSON,
    # so it clears the decode guard, and it parses to zero containers. Treating
    # that as "this host runs nothing" would record the endpoint as ok and hand
    # retire_absent an empty seen, closing every live container incident as
    # "removed" and wiping its streak.
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http, "get_json", _fake_http(_docker_ok(_entry("sonarr", state="exited")))
    )
    await collector.collect_containers(DOCKER_HOST, T0, db)
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30), db)
    assert _open_targets(db) == {"container:meleys/sonarr"}

    monkeypatch.setattr(
        collector.http,
        "get_json",
        _fake_http(
            HttpResult(ok=True, status=200, body='{"message":"page not found"}', reason="")
        ),
    )
    checks = await collector.collect_containers(DOCKER_HOST, T0 + timedelta(minutes=5), db)

    assert _targets(checks) == {"docker:meleys"}
    assert checks[0].ok is False
    assert checks[0].reason == "bad_json"
    rows = incidents.history(db, since=T0 - timedelta(hours=1))
    assert len(rows) == 1
    assert rows[0]["closed_at"] is None
    assert rows[0]["reason"] != "removed"


async def test_an_unreachable_docker_host_never_fabricates_a_container_incident(
    tmp_path, monkeypatch
):
    # meleys and vhagar have no socket proxy deployed, so this is every tick in
    # production today. Recording ok=False per container would open an incident
    # for every container on both boxes, forever.
    db = _db(tmp_path)
    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))

    for index in range(4):
        await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30 * index), db)

    assert _open_targets(db) == {"docker:meleys"}


async def test_an_unreachable_docker_host_never_closes_a_real_container_incident(
    tmp_path, monkeypatch
):
    # the other half of the trap: recording ok=True for containers we could not
    # see would silently close an outage that is still happening
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http, "get_json", _fake_http(_docker_ok(_entry("sonarr", state="exited")))
    )
    await collector.collect_containers(DOCKER_HOST, T0, db)
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30), db)
    assert _open_targets(db) == {"container:meleys/sonarr"}

    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))
    for index in range(2, 6):
        await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30 * index), db)

    still_open = {row["target"]: row for row in incidents.open_incidents(db)}
    assert "container:meleys/sonarr" in still_open
    assert still_open["container:meleys/sonarr"]["reason"] == "not_running"


async def test_an_unreachable_docker_host_never_retires_a_live_container(tmp_path, monkeypatch):
    # retire_absent is driven by the observed container set; an empty `seen`
    # from a failed fetch would close every container incident as "removed"
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http, "get_json", _fake_http(_docker_ok(_entry("sonarr", state="exited")))
    )
    await collector.collect_containers(DOCKER_HOST, T0, db)
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30), db)

    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(minutes=5), db)

    rows = incidents.history(db, since=T0 - timedelta(hours=1))
    assert len(rows) == 1
    assert rows[0]["closed_at"] is None
    assert rows[0]["reason"] != "removed"


async def test_a_successful_fetch_retires_a_container_that_is_gone(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.http, "get_json", _fake_http(_docker_ok(_entry("oldapp", state="exited")))
    )
    await collector.collect_containers(DOCKER_HOST, T0, db)
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(seconds=30), db)
    assert _open_targets(db) == {"container:meleys/oldapp"}

    monkeypatch.setattr(collector.http, "get_json", _fake_http(_docker_ok(_entry("sonarr"))))
    await collector.collect_containers(DOCKER_HOST, T0 + timedelta(minutes=5), db)

    assert incidents.open_incidents(db) == ()
    assert incidents.history(db, since=T0 - timedelta(hours=1))[0]["reason"] == "removed"


async def test_tick_covers_every_host_and_every_docker_host(tmp_path, monkeypatch):
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=True, stdout=_stdout(SECTIONS), reason=""))
    )
    monkeypatch.setattr(collector.http, "get_json", _fake_http(_docker_ok(_entry("sonarr"))))

    checks = await collector.tick(T0, db)

    assert {t for t in _targets(checks) if t.startswith("host:")} == {
        f"host:{host.name}" for host in config.HOSTS
    }
    assert {t for t in _targets(checks) if t.startswith("container:")} == {
        f"container:{host.name}/sonarr" for host in config.HOSTS if host.docker_url
    }
    assert store.last_heartbeat(db) == T0


async def test_tick_records_no_container_result_for_hosts_it_could_not_observe(
    tmp_path, monkeypatch
):
    # today's production shape: every host answers ssh, no host answers docker
    db = _db(tmp_path)
    monkeypatch.setattr(
        collector.ssh, "run", _fake_ssh(SshResult(ok=True, stdout=_stdout(SECTIONS), reason=""))
    )
    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))

    await collector.tick(T0, db)
    checks = await collector.tick(T0 + timedelta(seconds=30), db)

    assert not any(check.target.startswith("container:") for check in checks)
    assert _open_targets(db) == {
        f"docker:{host.name}" for host in config.HOSTS if host.docker_url
    }


async def test_tick_survives_one_wedged_host(tmp_path, monkeypatch):
    db = _db(tmp_path)

    async def _run(host, body, **kwargs):
        if host == "192.168.50.4":
            raise RuntimeError("wedged")
        return SshResult(ok=True, stdout=_stdout(SECTIONS), reason="")

    monkeypatch.setattr(collector.ssh, "run", _run)
    monkeypatch.setattr(collector.http, "get_json", _fake_http(DOCKER_REFUSED))

    checks = await collector.tick(T0, db)

    assert "host:caraxes" not in _targets(checks)
    assert "host:vermithor" in _targets(checks)
    assert store.last_heartbeat(db) == T0


def test_the_slow_tier_fires_on_the_first_round_and_every_thirtieth():
    assert collector.is_slow_round(0) is True
    assert [n for n in range(1, 30) if collector.is_slow_round(n)] == []
    assert collector.is_slow_round(30) is True
