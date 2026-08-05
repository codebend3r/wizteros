import logging

from stripe_bridge import tiers

# Meleys carries every library a tier can grant. The other Plex servers are
# retired from signups: their libraries are mirrored onto Meleys and renamed
# "(switch to Meleys)", and no tier may share them again.
LIBRARIES = [
    {"id": 23, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 24, "name": "02. 4K Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 25, "name": "03. Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 26, "name": "04. 4K Family Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 27, "name": "05. TV Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 28, "name": "06. 4K TV Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 29, "name": "14. Kid Shows", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 50, "name": "07. Disabled Stuff", "server_id": 2, "server_name": "Meleys", "enabled": False},
    {"id": 61, "name": "95. Private Stuff", "server_id": 2, "server_name": "Meleys", "enabled": True},
    # Retired servers below — enabled and non-private, but off-limits anyway.
    {"id": 9, "name": "01. Classic TV Shows (switch to Meleys)", "server_id": 5,
     "server_name": "Syrax", "enabled": True},
    {"id": 17, "name": "01. TV Shows (switch to Meleys)", "server_id": 1,
     "server_name": "Vermithor", "enabled": True},
    {"id": 22, "name": "06. Kid Shows (switch to Meleys)", "server_id": 1,
     "server_name": "Vermithor", "enabled": True},
    {"id": 30, "name": "01. UFC (switch to Meleys)", "server_id": 4,
     "server_name": "Caraxes", "enabled": True},
    {"id": 36, "name": "09. Basketball", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 37, "name": "99. Tutorials", "server_id": 4, "server_name": "Caraxes", "enabled": True},
    {"id": 40, "name": "01. 4K Movies (switch to Meleys)", "server_id": 3,
     "server_name": "Vhagar", "enabled": True},
]

RETIRED_IDS = {9, 17, 22, 30, 36, 37, 40}
PRIVATE_IDS = {37, 61}
FOUR_K_IDS = {24, 26, 28}


def test_no_tier_shares_off_the_share_server():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert RETIRED_IDS.isdisjoint(out["library_ids"]), tier
        assert out["server_ids"] == [2], tier
        assert out["server_names"] == ["Meleys"], tier


def test_share_server_guard_survives_tier_rule_bugs(monkeypatch):
    # Simulate a future tier-rule bug that wants every library shared; the
    # share-server filter must still strip every retired server's libraries.
    monkeypatch.setattr(tiers, "_tier_wants", lambda tier, lib: True)
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert RETIRED_IDS.isdisjoint(out["library_ids"]), tier


def test_private_libraries_appear_in_no_tier():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_private_guard_survives_tier_rule_bugs(monkeypatch):
    monkeypatch.setattr(tiers, "_tier_wants", lambda tier, lib: True)
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert PRIVATE_IDS.isdisjoint(out["library_ids"]), tier


def test_bronze_excludes_4k_and_disallows_downloads():
    out = tiers.resolve_tier_access(tier="bronze", libraries=LIBRARIES)
    assert out["library_ids"] == [23, 25, 27, 29]
    assert out["server_ids"] == [2]
    assert out["allow_downloads"] is False


def test_silver_includes_4k_without_downloads():
    out = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    assert FOUR_K_IDS <= set(out["library_ids"])
    assert out["library_ids"] == [23, 24, 25, 26, 27, 28, 29]
    assert out["allow_downloads"] is False


def test_gold_matches_silver_libraries_with_downloads_on():
    silver = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    gold = tiers.resolve_tier_access(tier="gold", libraries=LIBRARIES)
    assert gold["library_ids"] == silver["library_ids"]
    assert gold["server_ids"] == silver["server_ids"]
    assert gold["allow_downloads"] is True


def test_youth_gets_exactly_the_allowlist():
    out = tiers.resolve_tier_access(tier="youth", libraries=LIBRARIES)
    assert out["library_ids"] == [25, 26, 29]
    assert out["server_ids"] == [2]
    assert out["allow_downloads"] is True


def test_youth_ignores_the_retired_servers_mirror():
    # Vermithor still carries a "06. Kid Shows (switch to Meleys)" mirror; the
    # allowlist must resolve to the Meleys copy alone.
    out = tiers.resolve_tier_access(tier="youth", libraries=LIBRARIES)
    assert 22 not in out["library_ids"]
    assert 29 in out["library_ids"]


def test_youth_allowlist_miss_logs_and_proceeds(caplog):
    # "14. Kid Shows" renamed on the server -> log loudly, share what matched.
    renamed = [lib for lib in LIBRARIES if lib["id"] != 29]
    with caplog.at_level(logging.ERROR):
        out = tiers.resolve_tier_access(tier="youth", libraries=renamed)
    assert out["library_ids"] == [25, 26]
    assert "youth allowlist" in caplog.text


def test_youth_never_resolves_to_an_empty_scope(caplog):
    # An empty youth scope makes every youth checkout raise "no libraries
    # resolved" and retry forever, so no invite is ever delivered.
    with caplog.at_level(logging.ERROR):
        out = tiers.resolve_tier_access(tier="youth", libraries=LIBRARIES)
    assert out["library_ids"]
    assert "youth allowlist" not in caplog.text


def test_09_prefix_is_not_private():
    # "09. Basketball" starts with "09.", not "9X." -- the private rule leaves
    # it alone; the share-server filter is what keeps it out of every tier.
    assert tiers._is_private({"name": "09. Basketball"}) is False


def test_private_rule_is_name_only():
    # The 9X. guard keys off the name alone, so it fails closed even for a
    # library sitting on the share server itself.
    out = tiers.resolve_tier_access(tier="silver", libraries=LIBRARIES)
    assert 61 not in out["library_ids"]


def test_disabled_libraries_are_never_shared():
    for tier in ("bronze", "silver", "gold"):
        out = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert 50 not in out["library_ids"], tier


def test_tier_server_libraries_groups_gold_under_the_share_server():
    out = tiers.tier_server_libraries(tier="gold", libraries=LIBRARIES)
    assert out == {
        "Meleys": ["01. Movies", "02. 4K Movies", "03. Family Movies",
                   "04. 4K Family Movies", "05. TV Shows", "06. 4K TV Shows",
                   "14. Kid Shows"],
    }


def test_tier_server_libraries_bronze_drops_4k():
    out = tiers.tier_server_libraries(tier="bronze", libraries=LIBRARIES)
    assert out == {
        "Meleys": ["01. Movies", "03. Family Movies", "05. TV Shows", "14. Kid Shows"],
    }


def test_tier_server_libraries_youth_matches_allowlist():
    out = tiers.tier_server_libraries(tier="youth", libraries=LIBRARIES)
    assert out == {
        "Meleys": ["03. Family Movies", "04. 4K Family Movies", "14. Kid Shows"],
    }


def test_tier_server_libraries_never_lists_a_retired_server():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.tier_server_libraries(tier=tier, libraries=LIBRARIES)
        assert set(out) <= {"Meleys"}, tier


def test_tier_server_libraries_never_includes_private_or_disabled():
    for tier in tiers.TIER_DOWNLOADS:
        out = tiers.tier_server_libraries(tier=tier, libraries=LIBRARIES)
        names = [name for grouped in out.values() for name in grouped]
        assert "07. Disabled Stuff" not in names, tier
        assert not any(name.startswith("9") for name in names), tier


def test_tier_server_libraries_unknown_tier_grants_nothing():
    assert tiers.tier_server_libraries(tier="unknown", libraries=LIBRARIES) == {}


def test_stale_record_ids_returns_every_record_off_the_share_server():
    # Legacy members hold records on the retired servers. A Meleys-only scope
    # covers none of them and Wizarr has no per-server unshare, so the whole
    # set is disabled and the member re-joins through the invite.
    records = [
        {"id": 1, "server": "Meleys"},
        {"id": 2, "server": "Vermithor"},
        {"id": 3, "server": "Vhagar"},
    ]
    assert tiers.stale_record_ids(records=records, covered_servers=["Meleys"]) == [1, 2, 3]


def test_stale_record_ids_is_empty_when_every_record_is_covered():
    records = [{"id": 1, "server": "Meleys"}]
    assert tiers.stale_record_ids(records=records, covered_servers=["Meleys"]) == []


def test_stale_record_ids_fails_closed_on_a_missing_server_name():
    records = [{"id": 1, "server": "Meleys"}, {"id": 2, "server": None}]
    assert tiers.stale_record_ids(records=records, covered_servers=["Meleys"]) == [1, 2]


def test_normalize_tier_accepts_known_tiers_case_insensitively():
    assert tiers.normalize_tier("gold") == "gold"
    assert tiers.normalize_tier(" Silver ") == "silver"
    assert tiers.normalize_tier("YOUTH") == "youth"


def test_normalize_tier_maps_legacy_kids_to_youth():
    # Pre-rebrand Stripe metadata and stored rows still say "kids".
    assert tiers.normalize_tier("kids") == "youth"
    assert tiers.normalize_tier("KIDS") == "youth"
    assert tiers.canonical_tier("kids") == "youth"
    assert tiers.canonical_tier(None) is None


def test_normalize_tier_defaults_unknown_and_missing_to_bronze(caplog):
    with caplog.at_level(logging.ERROR):
        assert tiers.normalize_tier("platinum") == "bronze"
        assert tiers.normalize_tier(None) == "bronze"
        assert tiers.normalize_tier("") == "bronze"
        assert tiers.normalize_tier(123) == "bronze"
    assert "unknown tier" in caplog.text
