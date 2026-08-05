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
def test_every_tier_stays_on_the_share_server(tier):
    assert scope(tier)["server_names"] == [tiers.SHARE_SERVER]


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


def test_silver_and_gold_grant_every_shareable_library():
    shareable = sorted(
        lib["name"] for lib in LIBRARIES
        if lib["enabled"]
        and lib["server_name"] == tiers.SHARE_SERVER
        and not tiers.PRIVATE_NAME_RE.match(lib["name"])
    )
    assert names("silver") == shareable
    assert names("gold") == shareable


def test_only_gold_and_youth_allow_downloads():
    assert scope("gold")["allow_downloads"] is True
    assert scope("youth")["allow_downloads"] is True
    assert scope("silver")["allow_downloads"] is False
    assert scope("bronze")["allow_downloads"] is False


def test_youth_matches_its_allowlist_exactly():
    assert set(names("youth")) == set(tiers.YOUTH_LIBRARIES)


def test_bronze_grants_strictly_less_than_silver():
    assert set(names("bronze")) < set(names("silver"))
