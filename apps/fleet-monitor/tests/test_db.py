import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from fleet_monitor import api, collector, config, incidents, rollups, store
from fleet_monitor import db as fleet_db
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def _count_connections(monkeypatch):
    """Count how many sqlite files a block of work opens."""
    opened = []
    real = sqlite3.connect

    def counting(*args, **kwargs):
        opened.append(args[0] if args else kwargs.get("database"))
        return real(*args, **kwargs)

    monkeypatch.setattr(sqlite3, "connect", counting)
    return opened


def test_a_session_commits_on_success_and_closes(db_path):
    with fleet_db.session(db_path) as connection:
        store.init_db(connection)
        store.write_heartbeat(connection, T0)

    # a second, independent session sees it, so the first really committed
    with fleet_db.session(db_path) as connection:
        assert store.last_heartbeat(connection) == T0

    with pytest.raises(sqlite3.ProgrammingError):
        connection.execute("SELECT 1")


def test_a_session_rolls_back_and_still_closes(db_path):
    with fleet_db.session(db_path) as connection:
        store.init_db(connection)

    with pytest.raises(RuntimeError):
        with fleet_db.session(db_path) as connection:
            store.write_heartbeat(connection, T0)
            raise RuntimeError("the round died halfway")

    # the whole unit of work is undone: a round that died leaves no half-state
    with fleet_db.session(db_path) as connection:
        assert store.last_heartbeat(connection) is None


def test_one_fleet_response_opens_one_connection(db_path, monkeypatch):
    # it used to open three per host plus two, so five hosts cost seventeen
    collector.init_db(db_path)
    monkeypatch.setenv("FM_DB_PATH", db_path)
    with fleet_db.session(db_path) as connection:
        store.write_heartbeat(connection, T0)

    opened = _count_connections(monkeypatch)
    api.fleet()

    assert len(opened) == 1


def test_every_container_on_a_host_advances_in_one_transaction(db_path):
    """A round that dies partway leaves no container ahead of its siblings."""
    collector.init_db(db_path)
    checks = [
        incidents.CheckResult(target=f"container:meleys/app{index}", ok=False, reason="not_running")
        for index in range(3)
    ]

    with pytest.raises(RuntimeError):
        with fleet_db.session(db_path) as connection:
            for check in checks[:2]:
                incidents.record(connection, check, T0)
            raise RuntimeError("docker endpoint died mid-round")

    with fleet_db.session(db_path) as connection:
        streaks = connection.execute("SELECT COUNT(*) AS n FROM check_streak").fetchone()
    assert streaks["n"] == 0


def test_compact_scans_only_what_is_new(db):
    """The second run over unchanged data must not redo the first one's work.

    Without a lower bound this re-read and re-upserted the whole retention
    window every fifteen minutes, so a no-op cost exactly as much as a real
    compaction and grew with the database.
    """
    for offset in range(0, 1200, 60):
        store.write_samples(
            db, "host:meleys", T0 + timedelta(seconds=offset),
            [Sample("load.1m", 1.0, "gauge")],
        )
    later = T0 + timedelta(hours=1)

    first = rollups.compact(db, "5m", later)
    repeat = rollups.compact(db, "5m", later)

    assert first > 0
    # only the newest already-written bucket is revisited, to absorb a late
    # sample; everything behind it is left alone
    assert repeat == 1


def test_a_late_sample_still_lands_in_the_last_compacted_bucket(db):
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])
    later = T0 + timedelta(hours=1)
    rollups.compact(db, "5m", later)

    store.write_samples(db, "host:meleys", T0 + timedelta(seconds=30),
                        [Sample("load.1m", 3.0, "gauge")])
    rollups.compact(db, "5m", later)

    rows = rollups.read(db, "5m", "host:meleys", "load.1m")
    assert [(row[1], row[2], row[4]) for row in rows] == [(1.0, 3.0, 2)]


def test_every_resolution_carries_its_own_retention():
    assert {tier.name for tier in rollups.RESOLUTIONS} == {"5m", "1h"}
    assert [tier.table for tier in rollups.RESOLUTIONS] == ["rollup_5m", "rollup_1h"]


def test_an_unknown_resolution_never_reaches_the_query(db):
    with pytest.raises(KeyError):
        rollups.compact(db, "rollup_5m; DROP TABLE samples", T0)
    with pytest.raises(KeyError):
        rollups.read(db, "7d", "host:meleys", "load.1m")


def test_the_transport_factor_has_exactly_one_home():
    from fleet_monitor.transport import ssh

    assert config.MAX_ROUND_SECONDS == (
        config.VITALS_TIMEOUT + config.SLOW_TIMEOUT
    ) * ssh.CAPTURE_FACTOR
    assert not hasattr(config, "SSH_CAPTURE_FACTOR")


def test_a_tick_waits_for_a_compaction_rather_than_losing_itself(db_path):
    """Compaction moved off the event loop, so it can now genuinely overlap a
    round's write; it could not while it blocked the loop. sqlite serializes
    writers, and on the short default the round loses its whole tick to
    "database is locked" instead of waiting a moment for the lock.
    """
    collector.init_db(db_path)
    holding = threading.Event()

    def hold_the_write_lock():
        with fleet_db.session(db_path) as connection:
            store.write_heartbeat(connection, T0)
            holding.set()
            time.sleep(0.5)

    holder = threading.Thread(target=hold_the_write_lock)
    holder.start()
    assert holding.wait(timeout=5)

    try:
        with fleet_db.session(db_path) as connection:
            incidents.record(
                connection,
                incidents.CheckResult(target="host:meleys", ok=True, reason=""),
                T0,
            )
    finally:
        holder.join()

    with fleet_db.session(db_path) as connection:
        assert incidents.observed_run(connection, "host:meleys") is not None


def test_wal_keeps_a_reader_out_of_a_writers_way(db_path):
    collector.init_db(db_path)
    with fleet_db.session(db_path) as connection:
        mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode == "wal"
