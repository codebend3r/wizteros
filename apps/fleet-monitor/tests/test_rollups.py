from datetime import datetime, timedelta, timezone

from fleet_monitor import rollups, store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def _prepare(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    rollups.init_db(db)
    return db


def test_bucket_floors_to_the_resolution():
    at = datetime(2026, 8, 10, 12, 7, 43, tzinfo=timezone.utc)

    assert rollups.bucket(at, 300) == datetime(2026, 8, 10, 12, 5, tzinfo=timezone.utc)
    assert rollups.bucket(at, 3600) == datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)


def test_compact_writes_min_max_avg_per_bucket(tmp_path):
    db = _prepare(tmp_path)
    for offset, value in ((0, 1.0), (60, 3.0), (120, 2.0)):
        store.write_samples(db, "host:meleys", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", value, "gauge")])

    written = rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert written == 1
    rows = rollups.read(db, "5m", "host:meleys", "load.1m")
    assert rows == ((T0, 1.0, 3.0, 2.0, 3),)


def test_compact_does_not_touch_the_current_bucket(tmp_path):
    # the bucket still filling would be compacted from partial data and then
    # never corrected, so it is left alone until it closes
    db = _prepare(tmp_path)
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    assert rollups.compact(db, "5m", now=T0 + timedelta(seconds=30)) == 0


def test_compact_is_idempotent(tmp_path):
    db = _prepare(tmp_path)
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))
    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert len(rollups.read(db, "5m", "host:meleys", "load.1m")) == 1


def test_prune_drops_raw_samples_past_retention(tmp_path):
    db = _prepare(tmp_path)
    store.write_samples(db, "host:syrax", T0 - timedelta(days=8),
                        [Sample("load.1m", 9.0, "gauge")])
    store.write_samples(db, "host:syrax", T0, [Sample("load.1m", 1.0, "gauge")])

    dropped = rollups.prune(db, now=T0)

    assert dropped["samples"] == 1
    assert store.latest(db, "host:syrax")["load.1m"] == 1.0


def test_prune_keeps_rollups_longer_than_raw(tmp_path):
    _prepare(tmp_path)
    assert rollups.RETENTION["samples"] == timedelta(days=7)
    assert rollups.RETENTION["rollup_5m"] == timedelta(days=90)
    assert rollups.RETENTION["rollup_1h"] == timedelta(days=730)
