import logging
import re

log = logging.getLogger("bridge")

# Never-share rule: any library named "90. ..." through "99. ...", on any
# server. Name-only and deliberately server-agnostic (see _is_private).
PRIVATE_NAME_RE = re.compile(r"^9\d\.")

# Kids allowlist, matched on (server_name, library name).
KIDS_LIBRARIES = frozenset({
    ("Vermithor", "06. Kid Shows"),
    ("Meleys", "02. Family Movies"),
    ("Vermithor", "04. 4K Family Movies"),
})

TIER_DOWNLOADS = {
    "bronze": False,
    "silver": False,
    "gold": True,
    "kids": True,
}


def normalize_tier(raw) -> str:
    """Map checkout metadata to a known tier; unknown, missing, or non-string falls back to bronze."""
    tier = raw.strip().lower() if isinstance(raw, str) else ""
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


def _tier_wants(tier: str, library: dict) -> bool:
    """Whether a tier's rules include a library (before the private filter)."""
    if tier == "kids":
        return (library.get("server_name"), library.get("name")) in KIDS_LIBRARIES
    if tier == "bronze":
        return not _is_4k(library)
    return True  # silver / gold: everything


def _shareable_libraries(*, tier: str, libraries: list) -> list:
    """Enabled libraries a tier's rules include.

    The private filter runs last, independent of the tier rules, so no rule
    change can ever share a private library.
    """
    selected = [
        lib for lib in libraries
        if lib.get("enabled") and _tier_wants(tier, lib)
    ]
    return [lib for lib in selected if not _is_private(lib)]


def tier_server_libraries(*, tier: str, libraries: list) -> dict:
    """Shareable library names a tier grants, grouped by server name.

    Derived from the tier rules (what invites are scoped to), not read back
    from Plex — Wizarr's users API doesn't expose per-user libraries. Unknown
    tiers grant nothing.
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
    if tier == "kids" and len(shareable) < len(KIDS_LIBRARIES):
        found = {(lib.get("server_name"), lib.get("name")) for lib in shareable}
        log.error("kids allowlist mismatch; missing %s", sorted(KIDS_LIBRARIES - found))
    return {
        "library_ids": [lib["id"] for lib in shareable],
        "server_ids": sorted({lib["server_id"] for lib in shareable}),
        "allow_downloads": TIER_DOWNLOADS[tier],
    }
