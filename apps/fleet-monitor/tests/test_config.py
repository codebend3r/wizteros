from dataclasses import FrozenInstanceError

import pytest

from fleet_monitor import collector, config
from fleet_monitor.transport import ssh


def test_every_fleet_host_is_configured():
    assert {h.name for h in config.HOSTS} == {
        "vermithor", "meleys", "syrax", "vhagar", "caraxes"
    }


def test_only_vermithor_and_vhagar_have_a_render_node():
    # measured 2026-08-10: meleys is AMD, syrax is Atom, caraxes is ARM
    assert {h.name for h in config.HOSTS if h.has_gpu} == {"vermithor", "vhagar"}


def test_the_three_docker_hosts_are_configured():
    # vhagar joined on 2026-08-11 when Jellyfin was installed there; caraxes is
    # aarch64 and Synology's Container Manager is x86-only, so it never will
    assert {h.name for h in config.HOSTS if h.docker_url} == {
        "vermithor", "meleys", "vhagar"
    }


def test_ips_match_the_fleet():
    by_name = {h.name: h.ip for h in config.HOSTS}
    assert by_name["meleys"] == "192.168.50.2"
    assert by_name["vermithor"] == "192.168.50.3"
    assert by_name["caraxes"] == "192.168.50.4"
    assert by_name["syrax"] == "192.168.50.5"
    assert by_name["vhagar"] == "192.168.50.6"


def test_a_host_is_frozen():
    host = config.Host(name="ghost", ip="192.0.2.1", has_gpu=False, docker_url="")

    with pytest.raises(FrozenInstanceError):
        host.name = "other"


def test_db_path_defaults_and_honors_the_environment(monkeypatch):
    monkeypatch.delenv("FM_DB_PATH", raising=False)
    assert config.db_path() == "/data/fleet.db"

    monkeypatch.setenv("FM_DB_PATH", "/tmp/other.db")
    assert config.db_path() == "/tmp/other.db"


def test_ssh_user_defaults_and_honors_the_environment(monkeypatch):
    monkeypatch.delenv("FM_SSH_USER", raising=False)
    assert config.ssh_user() == "crivas"

    monkeypatch.setenv("FM_SSH_USER", "someone")
    assert config.ssh_user() == "someone"


def test_the_slow_tier_is_a_whole_multiple_of_the_vitals_tier():
    # run_forever counts vitals rounds to decide when the slow tier is due, so
    # a non-integer ratio would silently drift the 15 minute cadence
    assert config.SLOW_INTERVAL % config.VITALS_INTERVAL == 0


def test_the_round_budget_matches_the_transport_that_spends_it():
    # MAX_ROUND_SECONDS is derived, and store.COVERAGE_GAP is derived from it.
    # Nothing in the import graph ties that arithmetic to the transport it
    # describes, so this is the tie: if _capture's multiple ever changes, the
    # derived tolerance is wrong and this fails instead of a slow round
    # silently blanking every uptime score.
    assert config.SSH_CAPTURE_FACTOR == ssh.CAPTURE_FACTOR
    assert config.MAX_ROUND_SECONDS == (
        config.VITALS_TIMEOUT + config.SLOW_TIMEOUT
    ) * ssh.CAPTURE_FACTOR


def test_the_collectors_probe_timeouts_are_the_configured_ones():
    # the same tie for the other end: the derivation is only honest while the
    # collector actually spends these budgets
    assert (
        collector.collect_host.__kwdefaults__["timeout"] == config.VITALS_TIMEOUT
    )
    assert collector.collect_slow.__kwdefaults__["timeout"] == config.SLOW_TIMEOUT
