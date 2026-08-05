import logging
import os
import xml.etree.ElementTree as ET

import requests

log = logging.getLogger("bridge")

PLEX_TOKEN = os.environ.get("PLEX_TOKEN", "")
PLEX_TV_BASE = os.environ.get("PLEX_TV_BASE", "https://plex.tv")
TIMEOUT = 15


def _get_xml(path: str) -> ET.Element:
    """Fetch a plex.tv XML document with the owner token."""
    r = requests.get(
        f"{PLEX_TV_BASE}{path}",
        headers={"X-Plex-Token": PLEX_TOKEN},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return ET.fromstring(r.text)


def owned_servers() -> list[dict]:
    """The account's Plex servers from plex.tv (name + machineIdentifier)."""
    return [
        {"name": server.get("name"), "machine_id": server.get("machineIdentifier")}
        for server in _get_xml("/api/servers").iter("Server")
        if server.get("machineIdentifier")
    ]


def shared_access_all() -> dict[str, dict[str, dict]]:
    """Every shared account's plex.tv access, keyed by lowercased email then server.

    Ground truth straight from plex.tv's shared_servers, independent of
    Wizarr and of the bridge's tier rules, so it also covers legacy shares
    that never went through an invite. A shared_servers document lists every
    account a server is shared with, so the whole roster costs one call per
    owned server; looking up a single email is no cheaper.
    """
    access: dict[str, dict[str, dict]] = {}
    for server in owned_servers():
        root = _get_xml(f"/api/servers/{server['machine_id']}/shared_servers")
        for shared in root.iter("SharedServer"):
            email = (shared.get("email") or "").strip().lower()
            if not email:
                continue
            sections = [s for s in shared.iter("Section") if s.get("shared") == "1"]
            access.setdefault(email, {})[server["name"]] = {
                "all_libraries": shared.get("allLibraries") == "1",
                "allow_sync": shared.get("allowSync") == "1",
                "libraries": sorted(section.get("title") or "" for section in sections),
            }
    return access


def shared_access_for_email(email: str) -> dict[str, dict]:
    """The actual plex.tv share one email holds, per owned server.

    Empty dict when the email is not shared anywhere.
    """
    return shared_access_all().get(email.strip().lower(), {})
