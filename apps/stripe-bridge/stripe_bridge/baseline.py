import logging
import os
from datetime import datetime, timedelta, timezone

from stripe_bridge import plex, store, tiers

log = logging.getLogger("bridge.baseline")

# The four tiers a prospective member can be handed a link for. Derived from
# the tier rules rather than hard-coded so a new tier cannot be added without
# the baseline set following it.
BASELINE_TIERS = tuple(sorted(tiers.TIER_DOWNLOADS))

# How long a baseline link stays redeemable. Longer than the daily rotation on
# purpose: two generations overlap, so a link shared moments before 03:00 is
# still good for another day rather than dying underneath whoever received it.
BASELINE_EXPIRES_DAYS = int(os.environ.get("BASELINE_EXPIRES_DAYS", "2"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")


def _parse(value: str | None) -> datetime | None:
    """Parse a Wizarr/store timestamp into an aware UTC datetime, or None.

    Wizarr emits naive ISO strings that are really UTC, so a missing tzinfo is
    stamped as UTC rather than guessed from the host's local zone.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def mint_baseline_invite(*, client, db_path: str, tier: str, libraries: list,
                         now: datetime) -> dict | None:
    """Create one tier's baseline invite and record it as ours; None if it fails.

    Recording the code is what licenses a later rotation to reap it, so the
    write happens immediately after the invite exists.
    """
    access = tiers.resolve_tier_access(tier=tier, libraries=libraries)
    if not access["library_ids"]:
        log.error("baseline: %s resolves to no libraries; refusing to mint", tier)
        return None
    expires_at = (now + timedelta(days=BASELINE_EXPIRES_DAYS)).isoformat()
    invite = client.create_invite(
        access["server_ids"], BASELINE_EXPIRES_DAYS, ACCESS_DURATION,
        unlimited=True,
        library_ids=access["library_ids"],
        allow_downloads=access["allow_downloads"],
    )
    store.record_baseline_invite(
        db_path, code=invite["code"], tier=tier, expires_at=expires_at,
        created_at=now.isoformat())
    log.info("baseline: minted %s invite %s (%d libraries, servers %s, expires %s)",
             tier, invite["code"], len(access["library_ids"]),
             access["server_ids"], expires_at)
    return invite


def reap_expired_baselines(*, client, db_path: str, invitations: list,
                           now: datetime) -> list[str]:
    """Delete baselines we minted that have already passed their own expiry.

    Two guards make this safe: only codes recorded in baseline_invites are
    considered at all, and among those only ones already expired are removed.
    A member's checkout invite satisfies neither, so it can never be reaped.
    A code that has vanished upstream is simply forgotten locally.
    """
    by_code = {inv.get("code"): inv for inv in invitations}
    reaped = []
    for row in store.all_baseline_invites(db_path):
        expires_at = _parse(row["expires_at"])
        if expires_at is None or expires_at > now:
            continue
        live = by_code.get(row["code"])
        if live is None:
            store.forget_baseline_invite(db_path, row["code"])
            continue
        try:
            client.delete_invitation(live["id"])
        except Exception:
            log.exception("baseline: could not delete expired invite %s", row["code"])
            continue
        store.forget_baseline_invite(db_path, row["code"])
        reaped.append(row["code"])
    if reaped:
        log.info("baseline: reaped %d expired invite(s): %s", len(reaped), ", ".join(reaped))
    return reaped


def rotate_baseline_invites(*, client, db_path: str, now: datetime | None = None) -> dict:
    """Mint a fresh baseline invite per tier, then reap the ones already expired.

    Minting precedes reaping so that a failure part-way through leaves extra
    invites rather than none. A tier whose scope is currently broken is skipped
    with an alarm and keeps its existing invite, so a Plex library rename can
    never empty the baseline set.
    """
    now = now or datetime.now(timezone.utc)
    # Stale cache rows are dropped as on every other invite path: Plex rejects
    # an invite carrying a name it no longer knows, whole.
    libraries = tiers.without_stale(
        libraries=client.list_libraries(), live=plex.live_sections_or_none())
    broken = tiers.tier_scope_problems(libraries=libraries)
    minted, skipped = [], []
    for tier in BASELINE_TIERS:
        if tier in broken:
            log.error("baseline: skipping %s — %s", tier, broken[tier])
            skipped.append(tier)
            continue
        try:
            invite = mint_baseline_invite(
                client=client, db_path=db_path, tier=tier,
                libraries=libraries, now=now)
        except Exception:
            log.exception("baseline: minting %s failed", tier)
            skipped.append(tier)
            continue
        if invite is None:
            skipped.append(tier)
        else:
            minted.append({"tier": tier, "code": invite["code"]})
    reaped = reap_expired_baselines(
        client=client, db_path=db_path,
        invitations=client.list_invitations(), now=now)
    return {"minted": minted, "skipped": skipped, "reaped": reaped}


def audit_baseline_invites(*, client, db_path: str, now: datetime | None = None) -> dict:
    """Report how the live invitation set diverges from the baseline rules.

    Read-only. Scope is judged on server_names because Wizarr's serializer
    reports specific_libraries as [] even for a correctly scoped invite, so
    that field cannot separate a scoped invite from an unscoped one.
    """
    now = now or datetime.now(timezone.utc)
    invitations = client.list_invitations()
    owned = {row["code"]: row for row in store.all_baseline_invites(db_path)}
    by_code = {inv.get("code"): inv for inv in invitations}

    live_by_tier: dict[str, list[dict]] = {}
    no_expiry, wrong_scope = [], []
    for code, row in owned.items():
        inv = by_code.get(code)
        if inv is None:
            continue
        expires = _parse(inv.get("expires"))
        if expires is None:
            no_expiry.append({"code": code, "tier": row["tier"]})
        elif expires <= now:
            continue
        servers = sorted(inv.get("server_names") or [])
        if servers != [tiers.SHARE_SERVER]:
            wrong_scope.append({"code": code, "tier": row["tier"], "servers": servers})
        live_by_tier.setdefault(row["tier"], []).append(
            {"code": code, "expires": inv.get("expires")})

    missing = [tier for tier in BASELINE_TIERS if not live_by_tier.get(tier)]
    stale = [
        tier for tier, invites in live_by_tier.items()
        if all((created := _parse(owned[i["code"]]["created_at"])) is None
               or now - created > timedelta(hours=24) for i in invites)
    ]
    strays = [
        {"code": inv.get("code"), "servers": sorted(inv.get("server_names") or []),
         "expires": inv.get("expires")}
        for inv in invitations
        if inv.get("unlimited") and inv.get("code") not in owned
    ]
    return {
        "tiers_missing": missing,
        "no_expiry": no_expiry,
        "wrong_scope": wrong_scope,
        "rotation_stale": sorted(stale),
        "strays": strays,
        "live_by_tier": live_by_tier,
        "ok": not (missing or no_expiry or wrong_scope or stale),
    }
