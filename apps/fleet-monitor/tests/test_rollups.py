from datetime import datetime, timedelta, timezone

import pytest

from fleet_monitor import rollups, store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)

# these tests are about retention, not about the age floor `latest` takes, so
# the floor is set wide enough that it never decides an assertion here
ANY_AGE = T0 - timedelta(days=30)


def test_bucket_floors_to_the_resolution():
    at = datetime(2026, 8, 10, 12, 7, 43, tzinfo=timezone.utc)

    assert rollups.bucket(at, 300) == datetime(2026, 8, 10, 12, 5, tzinfo=timezone.utc)
    assert rollups.bucket(at, 3600) == datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)


def test_compact_writes_min_max_avg_per_bucket(db):
    for offset, value in ((0, 1.0), (60, 3.0), (120, 2.0)):
        store.write_samples(db, "host:meleys", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", value, "gauge")])

    written = rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert written == 1
    rows = rollups.read(db, "5m", "host:meleys", "load.1m")
    assert rows == ((T0, 1.0, 3.0, 2.0, 3),)


def test_compact_does_not_touch_the_current_bucket(db):
    # the bucket still filling would be compacted from partial data and then
    # never corrected, so it is left alone until it closes
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    assert rollups.compact(db, "5m", now=T0 + timedelta(seconds=30)) == 0


def test_compact_is_idempotent(db):
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))
    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert len(rollups.read(db, "5m", "host:meleys", "load.1m")) == 1


def test_prune_drops_raw_samples_past_retention(db):
    store.write_samples(db, "host:syrax", T0 - timedelta(days=8),
                        [Sample("load.1m", 9.0, "gauge")])
    store.write_samples(db, "host:syrax", T0, [Sample("load.1m", 1.0, "gauge")])

    dropped = rollups.prune(db, now=T0)

    assert dropped["samples"] == 1
    assert store.latest(db, "host:syrax", since=ANY_AGE)["load.1m"] == 1.0


def test_prune_boundary_is_strictly_older_than_the_window(db):
    store.write_samples(db, "host:onboundary", T0 - timedelta(days=7),
                        [Sample("load.1m", 1.0, "gauge")])
    store.write_samples(db, "host:pastboundary", T0 - timedelta(days=7, seconds=1),
                        [Sample("load.1m", 2.0, "gauge")])

    rollups.prune(db, now=T0)

    assert store.latest(db, "host:onboundary", since=ANY_AGE)["load.1m"] == 1.0
    assert store.latest(db, "host:pastboundary", since=ANY_AGE) == {}


def test_prune_keeps_rollups_longer_than_raw(db):
    assert rollups.SAMPLE_RETENTION == timedelta(days=7)
    assert rollups.resolution("5m").retention == timedelta(days=90)
    assert rollups.resolution("1h").retention == timedelta(days=730)

    old = T0 - timedelta(days=8)
    store.write_samples(db, "host:vhagar", old, [Sample("load.1m", 9.0, "gauge")])
    rollups.compact(db, "5m", now=old + timedelta(minutes=10))
    rollups.compact(db, "1h", now=old + timedelta(hours=2))

    rollups.prune(db, now=T0)

    assert store.latest(db, "host:vhagar", since=ANY_AGE) == {}
    assert len(rollups.read(db, "5m", "host:vhagar", "load.1m")) == 1
    assert len(rollups.read(db, "1h", "host:vhagar", "load.1m")) == 1


def test_read_rejects_an_unknown_resolution(db):
    # the resolution names a table and so is interpolated rather than bound;
    # the membership check is the only thing between a caller's string and
    # the SQL, and `compact` has had it all along

    with pytest.raises(KeyError):
        rollups.read(db, "5m; DROP TABLE samples", "host:vermithor", "load.1m")


def test_read_returns_the_compacted_buckets(db):
    for offset, value in ((0, 1.0), (60, 3.0)):
        store.write_samples(db, "host:vermithor", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", value, "gauge")])
    rollups.compact(db, "5m", T0 + timedelta(minutes=10))

    rows = rollups.read(db, "5m", "host:vermithor", "load.1m")

    assert len(rows) == 1
    assert rows[0][1] == 1.0
    assert rows[0][2] == 3.0
