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
    # config imports the factor from the transport that spends it, so the two
    # cannot drift apart any more. What still needs pinning is the arithmetic
    # built on top of it: store.COVERAGE_GAP is derived from this, and a wrong
    # tolerance silently blanks every uptime score on a slow round.
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


def test_every_host_has_a_plex_url():
    # Plex runs natively on all five boxes (measured 2026-09-18), so an empty
    # url here would silently drop a server from every play-history view
    assert {h.name for h in config.HOSTS if h.plex_url} == {
        "vermithor", "meleys", "syrax", "vhagar", "caraxes"
    }


def test_the_two_secure_only_servers_are_addressed_over_https():
    # vermithor and vhagar close a plain-http socket without a response
    # (measured 2026-09-18); the other three answer on http
    by_name = {h.name: h.plex_url for h in config.HOSTS}
    assert by_name["vermithor"] == "https://192.168.50.3:32400"
    assert by_name["vhagar"] == "https://192.168.50.6:32400"
    assert by_name["meleys"] == "http://192.168.50.2:32400"
    assert by_name["caraxes"] == "http://192.168.50.4:32400"
    assert by_name["syrax"] == "http://192.168.50.5:32400"


def test_a_host_defaults_to_no_plex():
    # the default keeps every existing Host(...) construction valid, and
    # matches the docker_url contract: empty means the capability is absent
    host = config.Host(name="ghost", ip="192.0.2.1", has_gpu=False, docker_url="")

    assert host.plex_url == ""


def test_plex_token_prefers_the_monitor_prefix_then_the_shared_name(monkeypatch):
    monkeypatch.delenv("FM_PLEX_TOKEN", raising=False)
    monkeypatch.delenv("PLEX_TOKEN", raising=False)
    assert config.plex_token() == ""

    # the bridge's token is in the same .env every compose service reads, so
    # the monitor works with no new variable at all
    monkeypatch.setenv("PLEX_TOKEN", "shared")
    assert config.plex_token() == "shared"

    monkeypatch.setenv("FM_PLEX_TOKEN", "own")
    assert config.plex_token() == "own"


def test_plex_lookback_days_defaults_to_a_year_and_survives_junk(monkeypatch):
    monkeypatch.delenv("FM_PLEX_LOOKBACK_DAYS", raising=False)
    assert config.plex_lookback_days() == 365

    monkeypatch.setenv("FM_PLEX_LOOKBACK_DAYS", "730")
    assert config.plex_lookback_days() == 730

    # a typo must not turn into a zero-day backfill or a crash at boot
    monkeypatch.setenv("FM_PLEX_LOOKBACK_DAYS", "a year")
    assert config.plex_lookback_days() == 365

    monkeypatch.setenv("FM_PLEX_LOOKBACK_DAYS", "-3")
    assert config.plex_lookback_days() == 365


def test_the_plex_cadences_are_whole_seconds_and_the_inventory_is_the_slow_one():
    assert config.PLEX_HISTORY_INTERVAL == 300
    assert config.PLEX_LIBRARY_INTERVAL == 6 * 3600
    assert config.PLEX_LIBRARY_INTERVAL % config.PLEX_HISTORY_INTERVAL == 0
