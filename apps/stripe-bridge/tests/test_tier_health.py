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
    assert "Kid Shows" in problems["youth"]


def test_renumbering_the_libraries_does_not_narrow_youth():
    # The 2026-08-19 Meleys regroup: the 4K libraries moved to the top, so
    # every "NN. " prefix shifted while the titles stayed put. An allowlist
    # keyed on the full name silently dropped youth from 3 libraries to 1.
    renumbered = [
        {**lib, "name": tiers.LIBRARY_PREFIX_RE.sub(f"{lib['id']}. ", lib["name"])}
        for lib in HEALTHY
    ]
    assert tiers.tier_scope_problems(libraries=renumbered) == {}
    scope = tiers.resolve_tier_access(tier="youth", libraries=renumbered)
    assert len(scope["library_ids"]) == len(tiers.YOUTH_LIBRARY_TITLES)


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
    # No plex.tv by default: the cache is trusted unless a test says otherwise.
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: None)
    return b


# Wizarr rows carry the Plex section id as external_id; plex.tv reports the
# same id next to the live title, which is the join the stale check uses.
CACHED = [{**lib, "external_id": f"x{lib['id']}"} for lib in HEALTHY]
LIVE_MELEYS = {f"x{lib['id']}": lib["name"] for lib in HEALTHY}
RENAMED_ON_PLEX = {"Meleys": {**LIVE_MELEYS, "x29": "22. Kid Shows"}}


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


# --- the wizarr library cache drifting from plex -----------------------------


def test_health_check_reports_a_stale_wizarr_cache(tmp_path, monkeypatch, caplog):
    # The 2026-09-04 bronze signup: Wizarr still said "33. Formula 1", Plex
    # said "22. Formula 1", and every invite carrying the old name was
    # rejected whole at redemption. Neither tier rule nor test could see it.
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = CACHED
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: RENAMED_ON_PLEX)
    with caplog.at_level(logging.ERROR):
        problems = b.check_tier_scopes()
    assert "wizarr cache on Meleys" in problems
    assert "14. Kid Shows" in problems["wizarr cache on Meleys"]
    b.send_alert_email.assert_called_once()
    _subject, body = b.send_alert_email.call_args.args
    assert "22. Kid Shows" in body


def test_health_check_trusts_the_cache_when_plex_tv_is_down(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = CACHED
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: None)
    assert b.check_tier_scopes() == {}
    b.send_alert_email.assert_not_called()


def test_health_check_is_quiet_when_the_cache_matches_plex(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = CACHED
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: {"Meleys": LIVE_MELEYS})
    assert b.check_tier_scopes() == {}
    b.send_alert_email.assert_not_called()


def test_checkout_scope_drops_a_library_plex_would_reject(tmp_path, monkeypatch, caplog):
    # The member gets everything Plex will accept instead of nothing.
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = CACHED
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: RENAMED_ON_PLEX)
    with caplog.at_level(logging.ERROR):
        access = b.resolve_tier_scope("bronze", context="checkout cs_test")
    assert 29 not in access["library_ids"]
    assert 23 in access["library_ids"]
    assert "14. Kid Shows" in caplog.text


def test_checkout_scope_keeps_everything_when_plex_tv_is_down(tmp_path, monkeypatch):
    b = _bridge(monkeypatch, tmp_path)
    b.client.list_libraries.return_value = CACHED
    monkeypatch.setattr(b.plex, "live_sections_or_none", lambda: None)
    access = b.resolve_tier_scope("bronze", context="checkout cs_test")
    assert 29 in access["library_ids"]
