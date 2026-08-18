from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from fleet_monitor import api, incidents, store
from fleet_monitor.probes.types import Sample


def _client(tmp_path, monkeypatch):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    incidents.init_db(db)
    monkeypatch.setenv("FM_DB_PATH", db)
    return TestClient(api.app), db


def _watched(*, db, target, since, until, gap=store.COVERAGE_GAP):
    """Record the two healthy checks that say this target was observed from
    `since` to `until`.

    Samples alone do not say that. A host with fresh readings whose checks
    stopped hours ago has hours nobody looked at, and uptime over them is
    unknown rather than perfect - so a test that wants a score has to state the
    observation, not just the data.
    """
    for at in (since, until):
        incidents.record(
            db, incidents.CheckResult(target=target, ok=True, reason=""), at, gap=gap
        )


def test_the_api_creates_its_own_schema_on_startup(tmp_path, monkeypatch):
    # every other test in this file calls init_db itself, which masks the fact
    # that nothing in the API ever did. sqlite3.connect() happily creates an
    # empty file, so against a fresh FM_DB_PATH the first query raised
    # "no such table: heartbeat" and answered 500. TestClient only runs the
    # lifespan inside a `with` block, which is exactly what is under test.
    db = str(tmp_path / "never-initialized.db")
    monkeypatch.setenv("FM_DB_PATH", db)

    with TestClient(api.app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/fleet").status_code == 200
        assert client.get("/incidents").status_code == 200


def test_health_reports_stale_when_no_heartbeat(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/health").json()

    assert body["stale"] is True
    assert body["heartbeat_age_seconds"] is None


def test_health_is_fresh_right_after_a_heartbeat(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_heartbeat(db, datetime.now(tz=timezone.utc))
    body = client.get("/health").json()

    assert body["stale"] is False
    assert body["heartbeat_age_seconds"] < 5


def test_health_goes_stale_after_three_missed_ticks(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_heartbeat(db, datetime.now(tz=timezone.utc) - timedelta(seconds=200))

    assert client.get("/health").json()["stale"] is True


def test_fleet_lists_every_configured_host(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_samples(db, "host:vermithor", datetime.now(tz=timezone.utc), [
        Sample("load.1m", 0.46, "gauge"),
        Sample("mem.total_bytes", 16_642_768_896.0, "gauge"),
        Sample("mem.available_bytes", 11_000_000_000.0, "gauge"),
    ])
    body = client.get("/fleet").json()

    assert {h["name"] for h in body["hosts"]} == {
        "vermithor", "meleys", "syrax", "vhagar", "caraxes"
    }
    vermithor = next(h for h in body["hosts"] if h["name"] == "vermithor")
    assert vermithor["metrics"]["load.1m"] == 0.46
    assert vermithor["has_gpu"] is True


def test_fleet_marks_a_never_collected_host_as_such(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # "not collected" must be its own state, never an implied healthy zero
    assert caraxes["collected"] is False
    assert caraxes["metrics"] == {}


def test_fleet_flags_a_host_whose_slow_tier_metrics_are_stale(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(db, "host:caraxes", now, [Sample("load.1m", 0.1, "gauge")])
    store.write_samples(
        db, "host:caraxes", now - timedelta(hours=6),
        [Sample("disk.percent", 42.0, "gauge")],
    )
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # the collector is alive and the fast tier is current, so the fleet-wide
    # heartbeat flag reads fresh - only the per-host metric age catches the
    # slow tier that died six hours ago behind it
    assert body["stale"] is False
    assert caraxes["collected"] is True
    assert caraxes["metrics_stale"] is True
    assert caraxes["oldest_metric_age_seconds"] > 5 * 3600


def test_fleet_never_reports_a_reading_it_cannot_date(tmp_path, monkeypatch):
    # the slow tier (disk, temperatures) died a week ago while the fast tier
    # kept reporting. Samples live seven days and the age window is a day, so
    # the disk reading outlived the only thing that could date it: it dropped
    # out of metric_ages, `metrics_stale` went false on the strength of the
    # fresh load reading, and the card printed a bare "Healthy" over a
    # seven-day-old disk number with no stale note anywhere.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(db, "host:caraxes", now, [Sample("load.1m", 0.1, "gauge")])
    store.write_samples(
        db, "host:caraxes", now - timedelta(days=7),
        [Sample("disk.volume1.used_percent", 42.0, "gauge")],
    )
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # the undatable value is absent, not reported as current
    assert "disk.volume1.used_percent" not in caraxes["metrics"]
    assert caraxes["metrics"]["load.1m"] == 0.1
    # and what remains really is fresh, so saying so is not a lie
    assert caraxes["metrics_stale"] is False
    assert caraxes["oldest_metric_age_seconds"] < 60


def test_fleet_dates_every_reading_it_reports(tmp_path, monkeypatch):
    # the invariant behind the case above, stated directly: `metrics` and the
    # age computation must always describe the same set. A metric visible to
    # one and invisible to the other is a value on the page with no age
    # accounted for anywhere.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    for offset, metric in (
        (timedelta(0), "load.1m"),
        (timedelta(hours=6), "disk.volume1.used_percent"),
        (timedelta(days=3), "temp.coretemp.package_c"),
        (timedelta(days=7), "net.veth8a3f21.rx_bytes"),
    ):
        store.write_samples(db, "host:caraxes", now - offset, [Sample(metric, 1.0, "gauge")])
    caraxes = next(
        h for h in client.get("/fleet").json()["hosts"] if h["name"] == "caraxes"
    )

    window = now - timedelta(seconds=api.METRIC_AGE_WINDOW)
    assert set(caraxes["metrics"]) == set(store.metric_ages(db, "host:caraxes", since=window))
    assert set(caraxes["metrics"]) == {"load.1m", "disk.volume1.used_percent"}


def test_a_container_removed_days_ago_stops_reporting_as_up(tmp_path, monkeypatch):
    # same mechanism, different surface: container.<name>.up is a sample like
    # any other, so a container removed more than a day ago kept its last "1"
    # and the card kept rendering it "Up" indefinitely
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(db, "host:meleys", now, [Sample("load.1m", 0.2, "gauge")])
    store.write_samples(
        db, "host:meleys", now - timedelta(days=3), [Sample("container.oldapp.up", 1.0, "gauge")]
    )
    meleys = next(h for h in client.get("/fleet").json()["hosts"] if h["name"] == "meleys")

    assert "container.oldapp.up" not in meleys["metrics"]


def test_fleet_marks_a_host_whose_every_reading_aged_out_as_not_collected(
    tmp_path, monkeypatch
):
    # rows exist for this host, all of them older than the age window. That is
    # neither fresh nor never-collected, and the card's "no current readings"
    # copy is written for exactly this: not collected *now*.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(
        db, "host:syrax", now - timedelta(days=3), [Sample("load.1m", 0.1, "gauge")]
    )
    syrax = next(h for h in client.get("/fleet").json()["hosts"] if h["name"] == "syrax")

    assert syrax["collected"] is False
    assert syrax["metrics"] == {}
    assert syrax["metrics_stale"] is True
    assert syrax["oldest_metric_age_seconds"] is None
    assert syrax["uptime_percent_24h"] is None


def test_fleet_never_collected_host_has_no_uptime(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # a host that was never checked is unknown, not a perfect uptime score
    assert caraxes["uptime_percent_24h"] is None


def test_fleet_drops_a_metric_source_that_stopped_producing(tmp_path, monkeypatch):
    # a veth renamed by a container restart is written once and never again.
    # Counted forever it pins metrics_stale true on a healthy docker host and
    # walks oldest_metric_age_seconds up to seven days.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(
        db, "host:vermithor", now - timedelta(days=3),
        [Sample("net.veth8a3f21.rx_bytes", 12.0, "counter")],
    )
    store.write_samples(db, "host:vermithor", now, [Sample("load.1m", 0.4, "gauge")])
    body = client.get("/fleet").json()
    vermithor = next(h for h in body["hosts"] if h["name"] == "vermithor")

    assert vermithor["metrics_stale"] is False
    assert vermithor["oldest_metric_age_seconds"] < 60


def test_fleet_reports_no_uptime_for_a_window_the_collector_did_not_watch(
    tmp_path, monkeypatch
):
    # the collector has been up for one round. Nothing observed the other 24
    # hours, and an empty incident history over unwatched hours is not proof
    # of uptime, so the honest answer is None - which the card reads as
    # "Unknown" rather than a perfect score.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now)
    store.write_samples(db, "host:caraxes", now, [Sample("load.1m", 0.1, "gauge")])
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    assert caraxes["collected"] is True
    assert caraxes["uptime_percent_24h"] is None


def test_fleet_scores_uptime_once_the_collector_has_watched_the_window(
    tmp_path, monkeypatch
):
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    # one unbroken run reaching back past the window: two rounds is enough to
    # express that, with a gap tolerance wide enough to admit the second
    store.write_heartbeat(db, now - timedelta(hours=25))
    store.write_heartbeat(db, now, gap=timedelta(days=2))
    # and the host itself checked across that run, not merely the collector
    # ticking beside it. A round that recorded no check for this host observed
    # the fleet, not the host.
    _watched(
        db=db,
        target="host:caraxes",
        since=now - timedelta(hours=25),
        until=now,
        gap=timedelta(days=2),
    )
    store.write_samples(db, "host:caraxes", now, [Sample("load.1m", 0.1, "gauge")])
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    assert caraxes["uptime_percent_24h"] == 100.0


def test_fleet_reports_no_uptime_for_a_host_the_collector_stopped_checking(
    tmp_path, monkeypatch
):
    # a persistent spawn_error: ssh cannot be started, so no host check is
    # recorded, while the collector keeps ticking and the docker endpoints
    # beside it keep recording failures. The collector-wide coverage mark ran
    # on unbroken through hours in which not one host was observed, and scored
    # them a flawless 100%.
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    store.write_heartbeat(db, now - timedelta(hours=25))
    store.write_heartbeat(db, now, gap=timedelta(days=2))
    # checks for this host stop six hours ago; its readings are still inside
    # the age window, so the card is still showing numbers
    _watched(
        db=db,
        target="host:caraxes",
        since=now - timedelta(hours=25),
        until=now - timedelta(hours=6),
        gap=timedelta(days=2),
    )
    store.write_samples(
        db, "host:caraxes", now - timedelta(hours=6), [Sample("load.1m", 0.1, "gauge")]
    )
    caraxes = next(
        h for h in client.get("/fleet").json()["hosts"] if h["name"] == "caraxes"
    )

    assert caraxes["collected"] is True
    assert caraxes["uptime_percent_24h"] is None


def test_a_future_timestamp_never_reads_as_fresh(tmp_path, monkeypatch):
    # a clock that stepped backwards leaves rows stamped ahead of now. A
    # negative age clears every staleness threshold, so the page would show
    # frozen values and affirmatively call them current.
    client, db = _client(tmp_path, monkeypatch)
    ahead = datetime.now(tz=timezone.utc) + timedelta(hours=6)
    store.write_heartbeat(db, ahead)
    store.write_samples(db, "host:caraxes", ahead, [Sample("load.1m", 0.1, "gauge")])

    health = client.get("/health").json()
    assert health["stale"] is True
    assert health["heartbeat_age_seconds"] is None

    caraxes = next(h for h in client.get("/fleet").json()["hosts"] if h["name"] == "caraxes")
    assert caraxes["metrics_stale"] is True
    assert caraxes["oldest_metric_age_seconds"] is None


def test_incidents_rejects_absurdly_large_hours(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    response = client.get("/incidents?hours=999999999999999999")

    assert response.status_code == 422


def test_incidents_rejects_a_negative_window(tmp_path, monkeypatch):
    # bounded above but not below: an extreme negative still overflowed the
    # timedelta into an unhandled 500 instead of a client error
    client, _ = _client(tmp_path, monkeypatch)

    assert client.get("/incidents?hours=-999999999999999999").status_code == 422
    assert client.get("/incidents?hours=0").status_code == 422


def test_incidents_splits_open_from_recent(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    for offset in (0, 30):
        incidents.record(db, incidents.CheckResult("host:caraxes", False, "timeout"),
                         now + timedelta(seconds=offset))
    body = client.get("/incidents?hours=24").json()

    assert len(body["open"]) == 1
    assert body["open"][0]["target"] == "host:caraxes"
    assert len(body["recent"]) == 1
