import logging
import re

log = logging.getLogger("bridge")

# Never-share rule: any library named "90. ..." through "99. ...", on any
# server. Name-only and deliberately server-agnostic (see _is_private).
PRIVATE_NAME_RE = re.compile(r"^9\d\.")

# The one Plex server every tier shares from. Meleys now carries a copy of
# every library worth sharing, so the other servers (Vermithor, Vhagar,
# Caraxes, Syrax) are retired from signups — their libraries survive only as
# "(switch to Meleys)" mirrors and must never be granted again.
SHARE_SERVER = "Meleys"

# Youth allowlist, matched on library name alone — every shareable library is
# on SHARE_SERVER, so the server half of the key added nothing but a second
# way to drift out of date. The names are the actual Plex library names; they
# do not follow the tier's branding.
YOUTH_LIBRARIES = frozenset({
    "03. Family Movies",
    "04. 4K Family Movies",
    "14. Kid Shows",
})

TIER_DOWNLOADS = {
    "bronze": False,
    "silver": False,
    "gold": True,
    "youth": True,
}

# Pre-rebrand tier names still live in old Stripe metadata and stored DB rows.
LEGACY_TIER_ALIASES = {"kids": "youth"}


def canonical_tier(raw):
    """A stored tier string mapped through the legacy aliases; no bronze fallback."""
    return LEGACY_TIER_ALIASES.get(raw, raw) if isinstance(raw, str) else raw


def normalize_tier(raw) -> str:
    """Map checkout metadata to a known tier; unknown, missing, or non-string falls back to bronze."""
    tier = raw.strip().lower() if isinstance(raw, str) else ""
    tier = LEGACY_TIER_ALIASES.get(tier, tier)
    if tier not in TIER_DOWNLOADS:
        log.error("unknown tier %r on checkout session; defaulting to bronze", raw)
        return "bronze"
    return tier


def _is_private(library: dict) -> bool:
    """Whether a library is in the never-share set (9X. names).

    Deliberately server-agnostic: the rule matches on name alone, never on
    server_name, so it fails closed if Wizarr ever returns a null or
    renamed server_name for a library that should stay private.
    """
    return bool(PRIVATE_NAME_RE.match(library.get("name") or ""))


def _is_4k(library: dict) -> bool:
    """Case-insensitive '4K' match on the library name."""
    return "4k" in (library.get("name") or "").lower()


def _is_on_share_server(library: dict) -> bool:
    """Whether a library lives on the one server every tier shares from.

    Exact match on server_name, so a library with a null or renamed server
    fails closed rather than leaking a retired server's copy into a tier.
    """
    return library.get("server_name") == SHARE_SERVER


def _tier_wants(tier: str, library: dict) -> bool:
    """Whether a tier's rules include a library (before the server/private filters)."""
    if tier == "youth":
        return (library.get("name") or "") in YOUTH_LIBRARIES
    if tier == "bronze":
        return not _is_4k(library)
    return True  # silver / gold: everything


def _shareable_libraries(*, tier: str, libraries: list) -> list:
    """Enabled libraries on the share server that a tier's rules include.

    The share-server and private filters run last, independent of the tier
    rules, so no rule change can ever share a private library or resurrect a
    retired server.
    """
    selected = [
        lib for lib in libraries
        if lib.get("enabled") and _tier_wants(tier, lib)
    ]
    return [lib for lib in selected
            if _is_on_share_server(lib) and not _is_private(lib)]


def tier_server_libraries(*, tier: str, libraries: list) -> dict:
    """Shareable library names a tier grants, grouped by server name.

    Keyed by server for the admin UI's per-server breakdown, though every tier
    now resolves to the single SHARE_SERVER entry. Derived from the tier rules
    (what invites are scoped to), not read back from Plex — Wizarr's users API
    doesn't expose per-user libraries. Unknown tiers grant nothing.
    """
    if tier not in TIER_DOWNLOADS:
        return {}
    grouped: dict[str, list[str]] = {}
    for lib in _shareable_libraries(tier=tier, libraries=libraries):
        server = lib.get("server_name")
        if server:
            grouped.setdefault(server, []).append(lib.get("name") or "")
    return {server: sorted(names) for server, names in grouped.items()}


def resolve_tier_access(*, tier: str, libraries: list) -> dict:
    """Compute an invite's scope for a tier from the live Wizarr library list."""
    shareable = _shareable_libraries(tier=tier, libraries=libraries)
    if tier == "youth" and len(shareable) < len(YOUTH_LIBRARIES):
        found = {lib.get("name") for lib in shareable}
        log.error("youth allowlist mismatch on %s; missing %s",
                  SHARE_SERVER, sorted(YOUTH_LIBRARIES - found))
    return {
        "library_ids": [lib["id"] for lib in shareable],
        "server_ids": sorted({lib["server_id"] for lib in shareable}),
        "server_names": sorted({lib.get("server_name") for lib in shareable
                                if lib.get("server_name")}),
        "allow_downloads": TIER_DOWNLOADS[tier],
    }


def tier_scope_problems(*, libraries: list) -> dict:
    """Tiers whose live scope is broken, mapped to a human-readable reason.

    Empty when every tier resolves. The tier rules match on library names, so
    a rename on the Plex side silently narrows or empties a tier without any
    code change — a tier that resolves to nothing cannot issue an invite at
    all, and its checkouts raise and retry forever. Callers run this against
    the live library list to turn that silent drift into an alert.
    """
    problems: dict[str, str] = {}
    for tier in TIER_DOWNLOADS:
        shareable = _shareable_libraries(tier=tier, libraries=libraries)
        if not shareable:
            problems[tier] = (
                f"no libraries resolved on {SHARE_SERVER} — checkouts for this "
                f"tier will fail and retry forever"
            )
        elif tier == "youth":
            missing = sorted(YOUTH_LIBRARIES - {lib.get("name") for lib in shareable})
            if missing:
                problems[tier] = (
                    f"allowlist entries missing from {SHARE_SERVER}: {', '.join(missing)}"
                )
    return problems


def stale_record_ids(*, records: list, covered_servers) -> list:
    """Record ids that must be disabled before an invite can safely re-scope.

    Redeeming an invite updates the share in place on every server the invite
    covers (Wizarr catches Plex's "already sharing" and rewrites the sections),
    so records on covered servers need no disable and the member keeps access
    through the invite window. But Wizarr has no per-server unshare — disable
    severs the whole plex.tv friendship — so if any record sits on a server the
    new scope does NOT cover (or has no server name), every record is returned
    and the caller falls back to disable-first (fail closed on stale access).

    Since every tier resolves to SHARE_SERVER alone, this returns the full set
    for any legacy member still holding a record on a retired server: that
    disable-and-re-join IS the migration onto the single server, at the cost of
    an access gap between the disable and the member redeeming their invite.
    """
    covered = set(covered_servers)
    if all(record.get("server") in covered for record in records):
        return []
    return [record["id"] for record in records]
