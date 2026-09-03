"""Tier scopes checked against a recorded snapshot of the real Wizarr library list.

Every other tier test builds its own fixture, so the fixture and the rules are
written together and always agree — which is why a Plex-side rename could empty
the youth tier for weeks without a single red test. This module reads a
committed snapshot of what Wizarr actually returns instead.

Refresh it with `bun run refresh:libraries` after any Plex library rename; the
diff is the review, and these assertions are what fail if a rename narrows or
empties a tier.
"""

import json
import pathlib

import pytest

from stripe_bridge import tiers

SNAPSHOT = pathlib.Path(__file__).parent / "fixtures" / "live-libraries.json"
LIBRARIES = json.loads(SNAPSHOT.read_text())["libraries"]


def scope(tier: str) -> dict:
    """The resolved access for a tier against the recorded snapshot."""
    return tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)


def names(tier: str) -> list[str]:
    """Library names a tier grants on the share server, sorted."""
    return tiers.tier_server_libraries(tier=tier, libraries=LIBRARIES).get(
        tiers.SHARE_SERVER, [])


def all_names(tier: str) -> list[str]:
    """Every library name a tier grants, across all of its servers, sorted."""
    grouped = tiers.tier_server_libraries(tier=tier, libraries=LIBRARIES)
    return sorted(name for names_ in grouped.values() for name in names_)


def test_the_snapshot_still_looks_like_a_real_wizarr_response():
    assert len(LIBRARIES) > 20
    assert all({"id", "name", "server_id", "server_name", "enabled"} <= set(lib)
               for lib in LIBRARIES)
    # more than one server, or the share-server filter is not being exercised
    assert len({lib["server_name"] for lib in LIBRARIES}) > 1


@pytest.mark.parametrize("tier", sorted(tiers.TIER_DOWNLOADS))
def test_every_tier_resolves_to_something(tier):
    # A tier resolving to nothing makes its checkouts raise and retry forever.
    assert scope(tier)["library_ids"], f"{tier} grants no libraries"


@pytest.mark.parametrize("tier", sorted(tiers.TIER_DOWNLOADS))
def test_no_tier_reaches_a_retired_server(tier):
    # Caraxes is retired outright: no tier may resolve a library there, and
    # the real snapshot still carries its libraries to prove the filter runs.
    assert "Caraxes" in {lib["server_name"] for lib in LIBRARIES}
    assert not tiers.RETIRED_SERVERS & set(scope(tier)["server_names"]), tier


@pytest.mark.parametrize("tier", sorted(set(tiers.TIER_DOWNLOADS) - {"gold"}))
def test_every_entry_tier_stays_on_the_share_server(tier):
    assert scope(tier)["server_names"] == [tiers.SHARE_SERVER]


def test_gold_spans_the_live_fleet():
    assert set(scope("gold")["server_names"]) == set(tiers.GOLD_SHARE_SERVERS)


@pytest.mark.parametrize("tier", sorted(tiers.TIER_DOWNLOADS))
def test_no_tier_grants_a_private_library(tier):
    assert not [n for n in names(tier) if tiers.PRIVATE_NAME_RE.match(n)]


@pytest.mark.parametrize("tier", sorted(tiers.TIER_DOWNLOADS))
def test_no_tier_grants_a_disabled_library(tier):
    disabled = {lib["id"] for lib in LIBRARIES if not lib["enabled"]}
    assert disabled.isdisjoint(scope(tier)["library_ids"])


def test_the_live_scope_check_is_happy_with_the_snapshot():
    # The same function the running bridge alerts on, against real names.
    assert tiers.tier_scope_problems(libraries=LIBRARIES) == {}


def test_bronze_is_everything_except_4k():
    everything = set(names("silver"))
    assert set(names("bronze")) == {n for n in everything if "4k" not in n.lower()}
    assert not [n for n in names("bronze") if "4k" in n.lower()]
    assert scope("bronze")["allow_downloads"] is False


def test_silver_grants_every_shareable_library_on_the_share_server():
    shareable = sorted(
        lib["name"] for lib in LIBRARIES
        if lib["enabled"]
        and lib["server_name"] == tiers.SHARE_SERVER
        and not tiers.PRIVATE_NAME_RE.match(lib["name"])
    )
    assert names("silver") == shareable
    assert names("gold") == shareable  # gold still grants all of them here


def test_gold_grants_every_shareable_library_across_its_servers():
    shareable = sorted(
        lib["name"] for lib in LIBRARIES
        if lib["enabled"]
        and lib["server_name"] in tiers.GOLD_SHARE_SERVERS
        and not tiers.PRIVATE_NAME_RE.match(lib["name"])
    )
    assert all_names("gold") == shareable
    assert len(shareable) > len(names("gold")), "gold must reach past the share server"


def test_only_gold_and_youth_allow_downloads():
    assert scope("gold")["allow_downloads"] is True
    assert scope("youth")["allow_downloads"] is True
    assert scope("silver")["allow_downloads"] is False
    assert scope("bronze")["allow_downloads"] is False


def test_youth_matches_its_allowlist_exactly():
    titles = {tiers.LIBRARY_PREFIX_RE.sub("", name) for name in names("youth")}
    assert titles == set(tiers.YOUTH_LIBRARY_TITLES)


def test_bronze_grants_strictly_less_than_silver():
    assert set(names("bronze")) < set(names("silver"))
