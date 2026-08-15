from datetime import datetime, timedelta, timezone

from fleet_monitor import incidents

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def _db(tmp_path):
    path = str(tmp_path / "fleet.db")
    incidents.init_db(path)
    return path


def _feed(path, target, flags, *, start=T0, step=30):
    return [
        incidents.record(
            path,
            incidents.CheckResult(target=target, ok=ok, reason="" if ok else "refused"),
            start + timedelta(seconds=step * index),
        )
        for index, ok in enumerate(flags)
    ]


def test_a_single_failure_does_not_open_an_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [True, False, True])

    assert incidents.open_incidents(path) == ()


def test_two_consecutive_failures_open_an_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [True, False, False])

    open_rows = incidents.open_incidents(path)
    assert len(open_rows) == 1
    assert open_rows[0]["target"] == "container:meleys/sonarr"
    assert open_rows[0]["reason"] == "refused"
    assert open_rows[0]["closed_at"] is None


def test_two_consecutive_successes_close_it(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:caraxes", [False, False, True, True])

    assert incidents.open_incidents(path) == ()
    closed = incidents.history(path, since=T0 - timedelta(hours=1))
    assert len(closed) == 1
    assert closed[0]["closed_at"] is not None


def test_a_flap_inside_an_open_incident_does_not_close_it(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:caraxes", [False, False, True, False, False])

    assert len(incidents.open_incidents(path)) == 1


def test_a_second_outage_opens_a_second_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:syrax", [False, False, True, True, False, False])

    assert len(incidents.open_incidents(path)) == 1
    assert len(incidents.history(path, since=T0 - timedelta(hours=1))) == 2


def test_uptime_percent_over_a_window(tmp_path):
    path = _db(tmp_path)
    # down for the middle 30 minutes of a 60 minute window
    incidents.record(path, incidents.CheckResult("host:vhagar", False, "timeout"), T0)
    incidents.record(path, incidents.CheckResult("host:vhagar", False, "timeout"),
                     T0 + timedelta(seconds=30))
    incidents.record(path, incidents.CheckResult("host:vhagar", True, ""),
                     T0 + timedelta(minutes=30))
    incidents.record(path, incidents.CheckResult("host:vhagar", True, ""),
                     T0 + timedelta(minutes=30, seconds=30))

    got = incidents.uptime_percent(path, "host:vhagar", since=T0, now=T0 + timedelta(hours=1))

    assert 49.0 < got < 51.0


def test_uptime_is_100_with_no_incidents(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True, True])

    assert incidents.uptime_percent(
        path, "host:vermithor", since=T0, now=T0 + timedelta(hours=1)
    ) == 100.0


def test_an_always_healthy_target_never_appears_in_history(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True, True, True])

    assert incidents.history(path, since=T0 - timedelta(hours=1)) == ()


def test_retire_absent_closes_an_incident_for_a_removed_container(tmp_path):
    # a container removed while down would otherwise stay "open" forever and
    # drag its uptime toward zero for eternity
    path = _db(tmp_path)
    _feed(path, "container:meleys/oldapp", [False, False])
    assert len(incidents.open_incidents(path)) == 1

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen={"sonarr", "radarr"}, at=T0 + timedelta(minutes=5)
    )

    assert closed == 1
    assert incidents.open_incidents(path) == ()
    assert incidents.history(path, since=T0 - timedelta(hours=1))[0]["reason"] == "removed"


def test_retire_absent_leaves_a_still_present_container_alone(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [False, False])

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen={"sonarr"}, at=T0 + timedelta(minutes=5)
    )

    assert closed == 0
    assert len(incidents.open_incidents(path)) == 1


def test_retire_absent_does_not_reach_across_hosts(tmp_path):
    # vermithor and meleys both run a container called sonarr; retiring one
    # host's set must never touch the other's
    path = _db(tmp_path)
    _feed(path, "container:vermithor/sonarr", [False, False])

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen=set(), at=T0 + timedelta(minutes=5)
    )

    assert closed == 0
    assert len(incidents.open_incidents(path)) == 1


def test_a_newly_discovered_container_needs_no_special_casing(tmp_path):
    # adding jellyfin to meleys must just work: first check, then normal rules
    path = _db(tmp_path)
    _feed(path, "container:meleys/jellyfin", [True, True])

    assert incidents.open_incidents(path) == ()
    assert incidents.uptime_percent(
        path, "container:meleys/jellyfin", since=T0, now=T0 + timedelta(hours=1)
    ) == 100.0
