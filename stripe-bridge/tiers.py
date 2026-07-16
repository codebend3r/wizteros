import logging
import re

log = logging.getLogger("bridge")

# Never-share rule: Caraxes libraries named "96. ..." through "99. ...".
PRIVATE_SERVER_NAME = "Caraxes"
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
    """Map checkout metadata to a known tier; unknown or missing falls back to bronze."""
    tier = (raw or "").strip().lower()
    if tier not in TIER_DOWNLOADS:
        log.error("unknown tier %r on checkout session; defaulting to bronze", raw)
        return "bronze"
    return tier


def _is_private(library: dict) -> bool:
    """Whether a library is in the never-share set (Caraxes 9X. names)."""
    return (
        library.get("server_name") == PRIVATE_SERVER_NAME
        and bool(PRIVATE_NAME_RE.match(library.get("name") or ""))
    )


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


def resolve_tier_access(*, tier: str, libraries: list) -> dict:
    """Compute an invite's scope for a tier from the live Wizarr library list.

    The private filter runs last, independent of the tier rules, so no rule
    change can ever share a private library.
    """
    selected = [
        lib for lib in libraries
        if lib.get("enabled") and _tier_wants(tier, lib)
    ]
    shareable = [lib for lib in selected if not _is_private(lib)]
    if tier == "kids" and len(shareable) < len(KIDS_LIBRARIES):
        found = {(lib.get("server_name"), lib.get("name")) for lib in shareable}
        log.error("kids allowlist mismatch; missing %s", sorted(KIDS_LIBRARIES - found))
    return {
        "library_ids": [lib["id"] for lib in shareable],
        "server_ids": sorted({lib["server_id"] for lib in shareable}),
        "allow_downloads": TIER_DOWNLOADS[tier],
    }
