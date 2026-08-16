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
    store.write_samples(db, "host:caraxes", now, [Sample("load.1m", 0.1, "gauge")])
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    assert caraxes["uptime_percent_24h"] == 100.0


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
