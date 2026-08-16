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

    got = incidents.uptime_percent(
        path, "host:vhagar", since=T0, now=T0 + timedelta(hours=1), observed_since=T0
    )

    assert 49.0 < got < 51.0


def test_uptime_is_100_with_no_incidents(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True, True])

    assert incidents.uptime_percent(
        path, "host:vermithor", since=T0, now=T0 + timedelta(hours=1), observed_since=T0
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
        path, "container:meleys/jellyfin", since=T0, now=T0 + timedelta(hours=1),
        observed_since=T0,
    ) == 100.0


def test_retire_absent_stops_uptime_percent_from_degrading_further(tmp_path):
    # this is the entire reason retire_absent exists: without it, a container
    # removed while down stays "open" and drags uptime toward zero forever
    path = _db(tmp_path)
    _feed(path, "container:meleys/oldapp", [False, False])  # opens at T0 + 30s, never closes

    still_open = incidents.uptime_percent(
        path, "container:meleys/oldapp", since=T0, now=T0 + timedelta(hours=1),
        observed_since=T0,
    )
    assert still_open < 5.0

    incidents.retire_absent(
        path, prefix="container:meleys/", seen=set(), at=T0 + timedelta(minutes=5)
    )

    an_hour_out = incidents.uptime_percent(
        path, "container:meleys/oldapp", since=T0, now=T0 + timedelta(hours=1),
        observed_since=T0,
    )
    a_day_out = incidents.uptime_percent(
        path, "container:meleys/oldapp", since=T0, now=T0 + timedelta(days=1),
        observed_since=T0,
    )

    # retirement fixes the down time at (opened_at, retired_at); as `now`
    # keeps advancing past retirement, uptime climbs toward 100 instead of
    # trending toward 0 the way a permanently open incident would
    assert an_hour_out > 90.0
    assert a_day_out > an_hour_out


def test_uptime_percent_clips_an_incident_that_opened_before_the_window(tmp_path):
    path = _db(tmp_path)
    # opens at T0 + 30s, closes at T0 + 90s: a 60 second outage
    _feed(path, "host:clip-check", [False, False, True, True])

    since = T0 + timedelta(seconds=60)
    now = T0 + timedelta(seconds=120)

    # since (T0+60s) falls inside the incident's [T0+30s, T0+90s) span, so
    # only the last 30 seconds of the outage are inside the window
    got = incidents.uptime_percent(
        path, "host:clip-check", since=since, now=now, observed_since=T0
    )

    assert 49.0 < got < 51.0


def test_uptime_is_unknown_for_a_window_nobody_watched(tmp_path):
    # the collector was down for 23 of the 24 hours, so there are no incident
    # rows for them - not because the target was up, but because nothing was
    # looking. A flawless score for that day is the exact lie this guards.
    path = _db(tmp_path)
    now = T0 + timedelta(hours=24)
    _feed(path, "host:vermithor", [True, True], start=now - timedelta(minutes=1))

    assert incidents.uptime_percent(
        path, "host:vermithor", since=T0, now=now, observed_since=now - timedelta(hours=1)
    ) is None


def test_uptime_scores_a_window_the_collector_watched_from_the_start(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True])

    assert incidents.uptime_percent(
        path, "host:vermithor", since=T0, now=T0 + timedelta(hours=1),
        observed_since=T0 - timedelta(hours=1),
    ) == 100.0


def test_a_continued_failure_updates_the_open_incident_reason(tmp_path):
    # a target degrading from timeout to auth is the same outage, but the
    # operator needs the reason it is failing for now, not the one it opened
    # with
    path = _db(tmp_path)
    for index in range(2):
        incidents.record(
            path, incidents.CheckResult("host:syrax", False, "timeout"),
            T0 + timedelta(seconds=30 * index),
        )
    assert incidents.open_incidents(path)[0]["reason"] == "timeout"

    incidents.record(
        path, incidents.CheckResult("host:syrax", False, "auth"), T0 + timedelta(seconds=60)
    )

    assert incidents.open_incidents(path)[0]["reason"] == "auth"


def test_an_unnamed_failure_never_overwrites_a_named_reason(tmp_path):
    path = _db(tmp_path)
    for index in range(2):
        incidents.record(
            path, incidents.CheckResult("host:syrax", False, "timeout"),
            T0 + timedelta(seconds=30 * index),
        )

    incidents.record(
        path, incidents.CheckResult("host:syrax", False, ""), T0 + timedelta(seconds=60)
    )

    assert incidents.open_incidents(path)[0]["reason"] == "timeout"


def test_a_non_default_threshold_is_honored(tmp_path):
    path = _db(tmp_path)
    target = "host:threshold-check"

    incidents.record(path, incidents.CheckResult(target, False, "down"), T0, threshold=3)
    incidents.record(
        path, incidents.CheckResult(target, False, "down"), T0 + timedelta(seconds=30),
        threshold=3,
    )
    assert incidents.open_incidents(path) == ()

    incidents.record(
        path, incidents.CheckResult(target, False, "down"), T0 + timedelta(seconds=60),
        threshold=3,
    )
    assert len(incidents.open_incidents(path)) == 1
