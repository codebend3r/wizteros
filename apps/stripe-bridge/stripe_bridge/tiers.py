import logging
import re

log = logging.getLogger("bridge")

# Never-share rule: any library named "90. ..." through "99. ...", on any
# server. Name-only and deliberately server-agnostic (see _is_private).
PRIVATE_NAME_RE = re.compile(r"^9\d\.")

# The Plex server the paid-entry tiers share from. Meleys carries a copy of
# every library worth sharing, so bronze, silver and youth resolve here alone.
SHARE_SERVER = "Meleys"

# Gold reaches past it, across the rest of the live fleet. These servers hold
# libraries Meleys does not mirror, and gold grants all of them.
GOLD_SHARE_SERVERS = frozenset({"Meleys", "Vermithor", "Vhagar", "Syrax"})

# Retired outright: no tier may resolve a library here and no member may keep a
# record on it. Listed separately from the per-tier sets so widening a tier can
# never quietly readmit it.
RETIRED_SERVERS = frozenset({"Caraxes"})


def tier_share_servers(tier: str) -> frozenset:
    """The Plex servers a tier may share from, retired servers already removed."""
    wanted = GOLD_SHARE_SERVERS if tier == "gold" else frozenset({SHARE_SERVER})
    return wanted - RETIRED_SERVERS

# Youth allowlist, matched on library title alone — every shareable library is
# on SHARE_SERVER, so the server half of the key added nothing but a second
# way to drift out of date. The titles are the actual Plex library names with
# the "NN. " ordering prefix stripped; they do not follow the tier's branding.
#
# Matching the title rather than the full name is deliberate. The prefixes are
# display ordering, not identity: regrouping the Plex libraries renumbers them
# without changing what they hold, and an allowlist keyed on the full name
# silently narrows the tier when that happens.
YOUTH_LIBRARY_TITLES = frozenset({
    "Family Movies",
    "4K Family Movies",
    "Kid Shows",
})

# Leading "NN. " ordering prefix on a Plex library name.
LIBRARY_PREFIX_RE = re.compile(r"^\d+\.\s*")

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


def library_title(library: dict) -> str:
    """A library's name with its "NN. " ordering prefix stripped."""
    return LIBRARY_PREFIX_RE.sub("", library.get("name") or "")


def _is_4k(library: dict) -> bool:
    """Case-insensitive '4K' match on the library name."""
    return "4k" in (library.get("name") or "").lower()


def _is_on_share_server(library: dict, tier: str) -> bool:
    """Whether a library sits on a server this tier is allowed to share from.

    Exact match on server_name, so a library with a null or renamed server
    fails closed rather than leaking a retired server's copy into a tier.
    """
    server = library.get("server_name")
    return bool(server) and server in tier_share_servers(tier)


def _tier_wants(tier: str, library: dict) -> bool:
    """Whether a tier's rules include a library (before the server/private filters)."""
    if tier == "youth":
        return library_title(library) in YOUTH_LIBRARY_TITLES
    if tier == "bronze":
        return not _is_4k(library)
    return True  # silver / gold: everything


def _shareable_libraries(*, tier: str, libraries: list) -> list:
    """Enabled libraries on a tier's servers that its rules include.

    The server and private filters run last, independent of the tier rules, so
    no rule change can ever share a private library or resurrect a retired
    server.
    """
    selected = [
        lib for lib in libraries
        if lib.get("enabled") and _tier_wants(tier, lib)
    ]
    return [lib for lib in selected
            if _is_on_share_server(lib, tier) and not _is_private(lib)]


def tier_server_libraries(*, tier: str, libraries: list) -> dict:
    """Shareable library names a tier grants, grouped by server name.

    Keyed by server for the admin UI's per-server breakdown: one entry for the
    entry tiers, one per fleet server for gold. Derived from the tier rules
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
    if tier == "youth" and len(shareable) < len(YOUTH_LIBRARY_TITLES):
        found = {library_title(lib) for lib in shareable}
        log.error("youth allowlist mismatch on %s; missing %s",
                  SHARE_SERVER, sorted(YOUTH_LIBRARY_TITLES - found))
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
            servers = ", ".join(sorted(tier_share_servers(tier)))
            problems[tier] = (
                f"no libraries resolved on {servers}: checkouts for this "
                f"tier will fail and retry forever"
            )
        elif tier == "youth":
            missing = sorted(YOUTH_LIBRARY_TITLES - {library_title(lib) for lib in shareable})
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

    A member holding a record on a server their new tier does not cover (a
    Caraxes record, or a fleet record under an entry tier) therefore returns
    the full set: that disable-and-re-join IS the migration onto the covered
    servers, at the cost of an access gap between the disable and the member
    redeeming their invite.
    """
    covered = set(covered_servers)
    if all(record.get("server") in covered for record in records):
        return []
    return [record["id"] for record in records]
