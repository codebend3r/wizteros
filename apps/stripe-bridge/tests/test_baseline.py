from datetime import datetime, timedelta, timezone

import pytest

from stripe_bridge import baseline, store, tiers

NOW = datetime(2026, 8, 11, 3, 0, tzinfo=timezone.utc)

# Enough of Meleys to resolve every tier: the youth allowlist in full, plus a
# non-4K library bronze/silver/gold pick up and a 4K one bronze must exclude.
LIBRARIES = [
    {"id": 1, "name": "01. Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 2, "name": "02. 4K Movies", "server_id": 2, "server_name": "Meleys", "enabled": True},
    {"id": 3, "name": "03. Family Movies", "server_id": 2, "server_name": "Meleys",
     "enabled": True},
    {"id": 4, "name": "04. 4K Family Movies", "server_id": 2, "server_name": "Meleys",
     "enabled": True},
    {"id": 14, "name": "14. Kid Shows", "server_id": 2, "server_name": "Meleys",
     "enabled": True},
]


class FakeWizarr:
    """A Wizarr stand-in that records invites in memory."""

    def __init__(self, libraries=None, invitations=None):
        """Start with the given library list and any pre-existing invitations."""
        self.libraries = LIBRARIES if libraries is None else libraries
        self.invitations = list(invitations or [])
        self.created = []
        self.deleted = []
        self._next_id = 100

    def list_libraries(self):
        """The configured library list."""
        return self.libraries

    def list_invitations(self):
        """Every invitation currently held."""
        return self.invitations

    def create_invite(self, server_ids, expires_in_days, duration, unlimited=False,
                      library_ids=None, allow_downloads=False):
        """Mint an invite, remembering the arguments it was called with."""
        self._next_id += 1
        code = f"CODE{self._next_id}"
        self.created.append({
            "code": code, "server_ids": list(server_ids),
            "expires_in_days": expires_in_days, "duration": duration,
            "unlimited": unlimited, "library_ids": list(library_ids or []),
            "allow_downloads": allow_downloads,
        })
        self.invitations.append({
            "id": self._next_id, "code": code, "unlimited": unlimited,
            "server_names": ["Meleys"], "used_by": None,
            "expires": (NOW + timedelta(days=expires_in_days)).isoformat(),
        })
        return {"code": code, "url": f"/j/{code}"}

    def delete_invitation(self, invitation_id):
        """Remove an invitation by id, recording the deletion."""
        self.deleted.append(invitation_id)
        self.invitations = [i for i in self.invitations if i["id"] != invitation_id]


@pytest.fixture
def db(tmp_path):
    """A freshly initialised bridge DB."""
    path = str(tmp_path / "bridge.db")
    store.init_db(path)
    return path


def test_rotation_mints_one_invite_per_tier(db):
    client = FakeWizarr()
    result = baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    assert sorted(m["tier"] for m in result["minted"]) == sorted(baseline.BASELINE_TIERS)
    assert len(baseline.BASELINE_TIERS) == 4
    assert result["skipped"] == []


def test_minted_invites_are_unlimited_and_carry_an_expiry(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    assert all(c["unlimited"] is True for c in client.created)
    assert all(c["expires_in_days"] == baseline.BASELINE_EXPIRES_DAYS for c in client.created)
    assert all(row["expires_at"] for row in store.all_baseline_invites(db))


def test_minted_scope_matches_the_tier_rules(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    for created, tier in zip(client.created, baseline.BASELINE_TIERS):
        access = tiers.resolve_tier_access(tier=tier, libraries=LIBRARIES)
        assert created["library_ids"] == access["library_ids"]
        assert created["server_ids"] == access["server_ids"]
        assert created["allow_downloads"] == tiers.TIER_DOWNLOADS[tier]


def test_never_deletes_an_invite_it_did_not_mint(db):
    member_invite = {"id": 9, "code": "MEMBER1", "unlimited": False,
                     "server_names": ["Meleys"], "used_by": None,
                     "expires": (NOW - timedelta(days=30)).isoformat()}
    client = FakeWizarr(invitations=[member_invite])
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    assert 9 not in client.deleted


def test_never_deletes_a_baseline_that_is_still_live(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    minted_ids = [i["id"] for i in client.invitations]
    # One hour later nothing has expired yet, so the previous generation stands.
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW + timedelta(hours=1))
    assert client.deleted == []
    assert all(i in [x["id"] for x in client.invitations] for i in minted_ids)


def test_reaps_the_previous_generation_once_it_expires(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    first = {i["id"] for i in client.invitations}
    later = NOW + timedelta(days=baseline.BASELINE_EXPIRES_DAYS, hours=1)
    baseline.rotate_baseline_invites(client=client, db_path=db, now=later)
    assert set(client.deleted) == first
    assert len(store.all_baseline_invites(db)) == len(baseline.BASELINE_TIERS)


def test_broken_tier_is_skipped_and_keeps_its_existing_invite(db):
    # Drop the youth allowlist libraries so that tier resolves to nothing.
    thin = [lib for lib in LIBRARIES if lib["name"] in {"01. Movies", "02. 4K Movies"}]
    client = FakeWizarr(libraries=thin)
    result = baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    assert "youth" in result["skipped"]
    assert "youth" not in [m["tier"] for m in result["minted"]]


def test_audit_is_clean_right_after_a_rotation(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    report = baseline.audit_baseline_invites(client=client, db_path=db, now=NOW)
    assert report["ok"] is True
    assert report["tiers_missing"] == []


def test_audit_flags_a_missing_tier(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    client.invitations = [i for i in client.invitations if i["code"] != client.created[0]["code"]]
    report = baseline.audit_baseline_invites(client=client, db_path=db, now=NOW)
    assert report["ok"] is False
    assert report["tiers_missing"]


def test_audit_flags_a_baseline_with_no_expiry(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    client.invitations[0]["expires"] = None
    report = baseline.audit_baseline_invites(client=client, db_path=db, now=NOW)
    assert report["ok"] is False
    assert report["no_expiry"]


def test_audit_flags_scope_beyond_the_share_server(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    client.invitations[0]["server_names"] = ["Meleys", "Vermithor", "Syrax"]
    report = baseline.audit_baseline_invites(client=client, db_path=db, now=NOW)
    assert report["ok"] is False
    assert report["wrong_scope"][0]["servers"] == ["Meleys", "Syrax", "Vermithor"]


def test_audit_reports_strays_without_deleting_them(db):
    stray = {"id": 1, "code": "1PYO3B8VPQ", "unlimited": True,
             "server_names": ["Vermithor", "Meleys", "Syrax"], "used_by": None,
             "expires": None}
    client = FakeWizarr(invitations=[stray])
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    report = baseline.audit_baseline_invites(client=client, db_path=db, now=NOW)
    assert [s["code"] for s in report["strays"]] == ["1PYO3B8VPQ"]
    assert 1 not in client.deleted


def test_audit_flags_a_rotation_that_stopped_running(db):
    client = FakeWizarr()
    baseline.rotate_baseline_invites(client=client, db_path=db, now=NOW)
    report = baseline.audit_baseline_invites(
        client=client, db_path=db, now=NOW + timedelta(days=1, hours=2))
    assert report["ok"] is False
    assert sorted(report["rotation_stale"]) == sorted(baseline.BASELINE_TIERS)
