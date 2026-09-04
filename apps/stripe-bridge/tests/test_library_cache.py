"""Wizarr's library cache checked against what Plex actually calls each section.

Wizarr shares by library NAME: at redemption it hands plexapi the names its
`library` table holds for the invite, and plexapi looks each one up on the
live server. Wizarr only refreshes that table when someone presses "scan
libraries", so a rename on the Plex side leaves a stale name in the cache,
and every invite carrying it is rejected whole ("Plex invitation failed",
KeyError on the old title). That is how a bronze signup on 2026-09-04 landed
with no access: "33. Formula 1" had become "22. Formula 1" on Meleys.

plex.tv reports each server's sections with the same id Wizarr stores as
`external_id`, so the bridge can spot the drift itself.
"""

from stripe_bridge import tiers

CACHE = [
    {"id": 58, "external_id": "145283096", "name": "33. Formula 1",
     "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 23, "external_id": "137390246", "name": "04. Movies",
     "server_id": 2, "server_name": "Meleys", "enabled": True},
    # Gone from Plex but disabled: no tier grants it, so nothing can be rejected.
    {"id": 14, "external_id": "138663380", "name": "05. Formula 1",
     "server_id": 5, "server_name": "Syrax", "enabled": False},
    {"id": 9, "external_id": "999", "name": "01. Classic TV Shows",
     "server_id": 5, "server_name": "Syrax", "enabled": True},
]

LIVE = {
    "Meleys": {
        "145283096": "22. Formula 1",
        "137390246": "04. Movies",
        "145789065": "24. Basketball",   # new on Plex, not yet in the cache
    },
    "Syrax": {"999": "01. Classic TV Shows"},
}


def test_a_renamed_library_is_stale():
    stale = tiers.stale_libraries(libraries=CACHE, live=LIVE)
    assert [(row["id"], row["name"], row["live_name"]) for row in stale] == [
        (58, "33. Formula 1", "22. Formula 1"),
    ]


def test_a_library_gone_from_plex_is_stale():
    live = {**LIVE, "Meleys": {k: v for k, v in LIVE["Meleys"].items() if k != "137390246"}}
    stale = tiers.stale_libraries(libraries=CACHE, live=live)
    assert {row["id"] for row in stale} == {58, 23}
    assert next(row for row in stale if row["id"] == 23)["live_name"] is None


def test_a_disabled_row_is_never_stale():
    assert 14 not in {row["id"] for row in tiers.stale_libraries(libraries=CACHE, live=LIVE)}


def test_a_row_on_a_retired_server_is_never_stale():
    # No tier shares from Caraxes, so its rows can never reach an invite and
    # a drifted Caraxes cache is not worth an hourly alarm.
    retired = next(iter(tiers.RETIRED_SERVERS))
    rows = [*CACHE, {"id": 30, "external_id": "137934871", "name": "01. UFC",
                     "server_id": 4, "server_name": retired, "enabled": True}]
    live = {**LIVE, retired: {}}
    assert 30 not in {row["id"] for row in tiers.stale_libraries(libraries=rows, live=live)}
    assert f"wizarr cache on {retired}" not in tiers.library_cache_problems(libraries=rows, live=live)


def test_a_server_plex_tv_does_not_list_is_skipped():
    # Nothing can be checked against a server plex.tv does not report, and an
    # unknown server is not a stale cache.
    live = {"Syrax": LIVE["Syrax"]}
    assert tiers.stale_libraries(libraries=CACHE, live=live) == []


def test_a_row_without_an_external_id_is_skipped():
    rows = [{k: v for k, v in row.items() if k != "external_id"} for row in CACHE]
    assert tiers.stale_libraries(libraries=rows, live=LIVE) == []


def test_no_live_view_means_nothing_is_stale():
    # plex.tv down is not drift: the cache is trusted as-is rather than
    # blocking every checkout on a third party.
    assert tiers.stale_libraries(libraries=CACHE, live=None) == []
    assert tiers.without_stale(libraries=CACHE, live=None) == CACHE


def test_without_stale_drops_exactly_the_stale_rows_in_order():
    kept = tiers.without_stale(libraries=CACHE, live=LIVE)
    assert [row["id"] for row in kept] == [23, 14, 9]


def test_a_tier_scope_never_carries_a_stale_library():
    # The invite still grants everything Plex will accept, rather than
    # nothing, and the scope check alerts on the dropped one.
    scope = tiers.resolve_tier_access(
        tier="bronze", libraries=tiers.without_stale(libraries=CACHE, live=LIVE))
    assert scope["library_ids"] == [23]


def test_dropping_a_stale_row_is_logged_with_the_remedy(caplog):
    with caplog.at_level("ERROR", logger="bridge"):
        tiers.without_stale(libraries=CACHE, live=LIVE)
    assert "33. Formula 1" in caplog.text
    assert "22. Formula 1" in caplog.text
    assert "rescan" in caplog.text.lower()


def test_cache_problems_are_keyed_by_server_and_read_like_a_remedy():
    problems = tiers.library_cache_problems(libraries=CACHE, live=LIVE)
    assert set(problems) == {"wizarr cache on Meleys"}
    reason = problems["wizarr cache on Meleys"]
    assert "'33. Formula 1' is now '22. Formula 1'" in reason
    assert "rescan" in reason.lower()


def test_cache_problems_name_a_library_that_vanished():
    live = {**LIVE, "Meleys": {k: v for k, v in LIVE["Meleys"].items() if k != "137390246"}}
    reason = tiers.library_cache_problems(libraries=CACHE, live=live)["wizarr cache on Meleys"]
    assert "'04. Movies' is gone" in reason


def test_a_healthy_cache_has_no_problems():
    healthy = [{**row, "name": "22. Formula 1"} if row["id"] == 58 else row for row in CACHE]
    assert tiers.library_cache_problems(libraries=healthy, live=LIVE) == {}
    assert tiers.library_cache_problems(libraries=healthy, live=None) == {}
