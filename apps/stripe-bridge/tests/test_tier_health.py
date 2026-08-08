import logging
from unittest.mock import MagicMock

from stripe_bridge import tiers

# A healthy live library list: Meleys carries every tier's libraries.
HEALTHY = [
    {"id": 23, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 24, "name": "02. 4K Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 25, "name": "03. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 26, "name": "04. 4K Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 29, "name": "14. Kid Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
]


def test_healthy_library_list_reports_no_problems():
    assert tiers.tier_scope_problems(libraries=HEALTHY) == {}


def test_a_tier_resolving_to_zero_libraries_is_reported():
    # This is the youth outage: the allowlist stopped matching any live name,
    # so every youth checkout raised "no libraries resolved" and retried forever.
    renamed = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    problems = tiers.tier_scope_problems(libraries=renamed)
    assert "youth" in problems
    assert "no libraries" in problems["youth"]


def test_a_partial_youth_allowlist_miss_is_reported():
    # Youth still resolves, so checkouts succeed — but members silently get a
    # narrower library set than the tier promises. Worth an alert on its own.
    partial = [lib for lib in HEALTHY if lib["id"] != 29]
    problems = tiers.tier_scope_problems(libraries=partial)
    assert "youth" in problems
    assert "14. Kid Shows" in problems["youth"]


def test_an_empty_library_list_reports_every_tier():
    problems = tiers.tier_scope_problems(libraries=[])
    assert set(problems) == set(tiers.TIER_DOWNLOADS)


def test_the_share_server_vanishing_reports_every_tier():
    # Meleys renamed or dropped out of Wizarr -> nothing is shareable at all.
    moved = [{**lib, "server_name": "Somewhere Else"} for lib in HEALTHY]
    problems = tiers.tier_scope_problems(libraries=moved)
    assert set(problems) == set(tiers.TIER_DOWNLOADS)


def test_problems_are_keyed_by_tier_with_readable_reasons():
    problems = tiers.tier_scope_problems(libraries=[])
    assert all(isinstance(reason, str) and reason for reason in problems.values())


# --- the alerting side ------------------------------------------------------


def _bridge(monkeypatch, tmp_path):
    """The bridge module with a temp db, a mocked Wizarr client and a mocked alert mail."""
    import importlib

    from stripe_bridge import store
    from stripe_bridge import stripe_wizarr_bridge as b
    importlib.reload(b)
    dbp = str(tmp_path / "bridge.db")
    store.init_db(dbp)
    monkeypatch.setattr(b, "MAP_DB_PATH", dbp)
    b.client = MagicMock()
    monkeypatch.setattr(b, "send_alert_email", MagicMock())
    return b


def test_health_check_alerts_when_a_tier_breaks(tmp_path, monkeypatch, caplog):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    with caplog.at_level(logging.ERROR):
        broken = b.check_tier_scopes()
    assert "youth" in broken
    b.send_alert_email.assert_called_once()
    _subject, body = b.send_alert_email.call_args.args
    assert "youth" in body


def test_health_check_stays_quiet_while_healthy(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = HEALTHY
    assert b.check_tier_scopes() == {}
    b.send_alert_email.assert_not_called()


def test_health_check_does_not_re_alert_for_an_unchanged_problem(tmp_path, monkeypatch):
    # The sweep runs hourly; a standing breakage must not mail hourly.
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    b.check_tier_scopes()
    b.check_tier_scopes()
    b.check_tier_scopes()
    assert b.send_alert_email.call_count == 1


def test_health_check_re_alerts_when_the_problem_changes(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    b.check_tier_scopes()
    b.client.list_libraries.return_value = []  # every tier now broken
    b.check_tier_scopes()
    assert b.send_alert_email.call_count == 2


def test_health_check_alerts_again_after_a_recovery(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    b.check_tier_scopes()
    b.client.list_libraries.return_value = HEALTHY   # recovered
    b.check_tier_scopes()
    b.client.list_libraries.return_value = [lib for lib in HEALTHY if lib["id"] not in (25, 26, 29)]
    b.check_tier_scopes()                            # broke again -> alert again
    assert b.send_alert_email.call_count == 2


def test_health_check_survives_a_failing_alert(tmp_path, monkeypatch):
    # SMTP being down must not take out the reconcile loop that calls this.
    b = _bridge(monkeypatch, tmp_path)
    b.send_alert_email.side_effect = OSError("smtp down")
    b.client.list_libraries.return_value = []
    assert b.check_tier_scopes()  # returns the problems, does not raise


def test_health_check_survives_wizarr_being_down(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.side_effect = OSError("wizarr down")
    assert b.check_tier_scopes() == {}
    b.send_alert_email.assert_not_called()  # unreachable != misconfigured
