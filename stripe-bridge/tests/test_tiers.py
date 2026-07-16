import logging

import tiers

LIBRARIES = [
    {"id": 9, "name": "01. Classic TV Shows", "server_id": 5, "server_name": "Syrax", "enabled": True},
    {"id": 17, "name": "01. TV Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 20, "name": "04. 4K Family Movies", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 22, "name": "06. Kid Shows", "server_id": 1, "server_name": "Vermithor", "enabled": True},
    {"id": 23, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 24, "name": "02. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 25, "name": "03. 4K TV Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 28, "name": "01. 4K Movies", "server_id": 3, "server_name": "Vhagar", "enabled": True},
    {"id": 30, "name": "01. UFC", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 36, "name": "09. Basketball", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 38, "name": "97. Home Videos", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 39, "name": "98. Documents", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 40, "name": "96. Assignments", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 50, "name": "07. Disabled Stuff", "server_id": 2, "server_name": "Meleys", "enabled": False},
    {"id": 60, "name": "95. Private Stuff", "server_id": 1, "server_name": "Vermithor", "enabled": True},
]

PRIVATE_IDS = {37, 38, 39, 40, 60}
FOUR_K_IDS = {20, 25, 28}


def test_private_libraries_appear_in_no_tier():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_private_guard_survives_tier_rule_bugs(monkeypatch):
    # Simulate a future tier-rule bug that wants every library shared; the
    # final private filter must still strip the 9X. Caraxes libraries.
    monkeypatch.setattr(tiers, "_tier_wants", lambda tier, lib: True)
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_bronze_excludes_4k_and_disallows_downloads():
    out = tiers.resolve_tier_access(tier="bronze", libraries=LIBRARIES)
    assert out["library_ids"] == [9, 17, 22, 23, 24, 30, 36]
    assert out["server_ids"] == [1, 2, 4, 5]
    assert out["allow_downloads"] is False


def test_silver_includes_4k_without_downloads():
    out = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    assert FOUR_K_IDS <= set(out["library_ids"])
    assert out["library_ids"] == [9, 17, 20, 22, 23, 24, 25, 28, 30, 36]
    assert out["server_ids"] == [1, 2, 3, 4, 5]
    assert out["allow_downloads"] is False


def test_gold_matches_silver_libraries_with_downloads_on():
    silver = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    gold = tiers.resolve_tier_access(tier="gold", libraries=LIBRARIES)
    assert gold["library_ids"] == silver["library_ids"]
    assert gold["server_ids"] == silver["server_ids"]
    assert gold["allow_downloads"] is True


def test_kids_gets_exactly_the_allowlist():
    out = tiers.resolve_tier_access(tier="kids", libraries=LIBRARIES)
    assert out["library_ids"] == [20, 22, 24]
    assert out["server_ids"] == [1, 2]
    assert out["allow_downloads"] is True


def test_kids_allowlist_miss_logs_and_proceeds(caplog):
    # "06. Kid Shows" renamed on the server -> log loudly, share what matched.
    renamed = [lib for lib in LIBRARIES if lib["id"] != 22]
    with caplog.at_level(logging.ERROR):
        out = tiers.resolve_tier_access(tier="kids", libraries=renamed)
    assert out["library_ids"] == [20, 24]
    assert "kids allowlist" in caplog.text


def test_caraxes_09_prefix_is_not_private():
    # "09. Basketball" starts with "09.", not "9X." -- it is shareable.
    out = tiers.resolve_tier_access(tier="bronze", libraries=LIBRARIES)
    assert 36 in out["library_ids"]


def test_private_rule_is_server_agnostic():
    # "95. Private Stuff" lives on Vermithor, not Caraxes; the name-only rule
    # must exclude it regardless, proving the guard doesn't key off server
    # identity and so fails closed if server metadata drifts.
    out = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    assert 60 not in out["library_ids"]


def test_disabled_libraries_are_never_shared():
    for tier in ("bronze", "silver", "gold"):
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert 50 not in out["library_ids"], tier


def test_normalize_tier_accepts_known_tiers_case_insensitively():
    assert tiers.normalize_tier("gold") == "gold"
    assert tiers.normalize_tier(" Silver ") == "silver"
    assert tiers.normalize_tier("KIDS") == "kids"


def test_normalize_tier_defaults_unknown_and_missing_to_bronze(caplog):
    with caplog.at_level(logging.ERROR):
        assert tiers.normalize_tier("platinum") == "bronze"
        assert tiers.normalize_tier(None) == "bronze"
        assert tiers.normalize_tier("") == "bronze"
        assert tiers.normalize_tier(123) == "bronze"
    assert "unknown tier" in caplog.text
