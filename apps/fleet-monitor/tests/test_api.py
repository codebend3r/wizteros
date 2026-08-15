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
        db, "host:caraxes", now - timedelta(days=7),
        [Sample("disk.percent", 42.0, "gauge")],
    )
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # the collector is alive and the fast tier is current, so the fleet-wide
    # heartbeat flag reads fresh - only the per-host metric age catches the
    # week-dead slow tier hiding behind it
    assert body["stale"] is False
    assert caraxes["collected"] is True
    assert caraxes["metrics_stale"] is True
    assert caraxes["oldest_metric_age_seconds"] > 6 * 24 * 3600


def test_fleet_never_collected_host_has_no_uptime(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # a host that was never checked is unknown, not a perfect uptime score
    assert caraxes["uptime_percent_24h"] is None


def test_incidents_rejects_absurdly_large_hours(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    response = client.get("/incidents?hours=999999999999999999")

    assert response.status_code == 422


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
