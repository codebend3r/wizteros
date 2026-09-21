"""The one way an invite is scoped and minted, wherever it is asked for.

A checkout, an access recovery, an admin reissue and the baseline rotation all
hand a member the same kind of link, so they resolve the tier's libraries and
call Wizarr through here rather than each repeating the pipeline. What differs
between them is only the reaction to a tier that resolves to nothing, which is
why that case is raised rather than decided here: the webhook wants the event
left unmarked for Stripe to retry, the admin route wants a 502, and the
rotation wants to skip the tier and carry on.

The caller passes its own Wizarr client in: the bridge and the admin router
each hold one, and the tests rebind those module attributes.
"""

import logging

from stripe_bridge import plex, tiers
from stripe_bridge.config import ACCESS_DURATION, INVITE_DAYS

log = logging.getLogger("bridge.invites")


class TierScopeEmpty(RuntimeError):
    """A tier resolved to no libraries, so there is nothing to issue an invite for.

    Always a misconfiguration or a library rename, never a normal state: an
    invite scoped to nothing grants nothing, and handing one to a member who
    just paid is worse than refusing to mint it.
    """


def tier_scope(*, tier: str, libraries: list, context: str) -> dict:
    """The tier's access over the given library list; raises TierScopeEmpty when empty.

    `context` names the caller in the exception, so an operator reading a
    traceback knows which delivery or route hit it.
    """
    access = tiers.resolve_tier_access(tier=tier, libraries=libraries)
    if not access["library_ids"]:
        raise TierScopeEmpty(f"no libraries resolved for tier {tier!r} on {context!r}")
    return access


def live_scope(*, client, tier: str, context: str) -> dict:
    """The tier's access over the live library list; raises TierScopeEmpty when empty.

    Rows Wizarr's cache still names the old way are dropped first: Plex rejects
    an invite carrying a stale name whole, so the member is better off with
    everything else than with nothing, and the scope check alerts on the drop.
    """
    libraries = tiers.without_stale(
        libraries=client.list_libraries(), live=plex.live_sections_or_none())
    return tier_scope(tier=tier, libraries=libraries, context=context)


def mint(*, client, tier: str, scope: dict, allow_downloads: bool | None = None,
         expires_in_days: int = INVITE_DAYS, unlimited: bool = False) -> dict:
    """Create one tier-scoped Wizarr invite and return its {"code", "url"}.

    allow_downloads=None takes the tier's own setting; an admin override is
    passed in instead. `unlimited` is sent only when it is on, since Wizarr
    defaults it off and a single-use link is what every member-facing path
    wants; only the baseline rotation mints a shareable one.
    """
    invite = client.create_invite(
        scope["server_ids"], expires_in_days, ACCESS_DURATION,
        library_ids=scope["library_ids"],
        allow_downloads=(scope["allow_downloads"] if allow_downloads is None
                         else allow_downloads),
        **({"unlimited": True} if unlimited else {}),
    )
    log.info("created %s invite (%d libraries, servers %s)",
             tier, len(scope["library_ids"]), scope["server_ids"])
    return invite
