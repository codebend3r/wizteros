#!/usr/bin/env python3
"""Clear finished downloads out of Vermithor's SABnzbd Complete folder.

Runs on Vermithor as root (DSM Task Scheduler, daily 02:00), installed into the
media stack's compose project as scripts/sab_complete_cleanup.py by the
sab-complete-cleanup skill. Radarr and Sonarr remove what they grab after
import, so anything left in Complete was sent to SABnzbd some other way and
nothing else will ever delete it.

Every path and port comes from the running containers (their compose labels,
mounts and port bindings) and from SABnzbd's own complete_dir, never from a
constant. judge() is the whole delete rule; everything else gathers its inputs
or acts on its answer.

Dry run by default; pass --apply to delete. Aborts, deleting nothing further,
if docker, SABnzbd or Radarr cannot be read, since every verdict depends on
them. Python 3.8, which is what DSM 7.3 ships.
"""
import argparse
import collections
import json
import logging
import logging.handlers
import os
import posixpath
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from typing import Callable, Dict, Iterable, NamedTuple, Optional, Set

DOCKER = "/usr/local/bin/docker"
LOG = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "logs", "sab-complete-cleanup.log")

TV_TAG = re.compile(r"(^|[ ._-])S\d{1,4}(E\d{1,3})?([ ._-]|$)", re.I)
FINISHED = ("Completed", "Failed")

FindMovie = Callable[[str], Optional[dict]]


class Service(NamedTuple):
    """A running container: where its API answers and where its mounts live on the host."""

    url: str
    mounts: Dict[str, str]


class Entry(NamedTuple):
    """One top-level item in the Complete folder, as judge() needs to see it."""

    name: str
    path: str
    is_link: bool
    size: int
    newest: float


class Decision(NamedTuple):
    """What to do with an entry, and the reason the log prints for it."""

    delete: bool
    reason: str
    detail: str = ""


def judge(entry: Entry, active: Set[str], cutoff: float, find_movie: FindMovie) -> Decision:
    """The delete rule: TV releases, and movies Radarr already has a file for.

    A movie Radarr tracks without a file is the only copy and wants importing,
    and one Radarr cannot match is the owner's call, so both stay.
    """
    if entry.is_link:
        return Decision(False, "symlink")
    if entry.name in active:
        return Decision(False, "active")
    if entry.newest > cutoff:
        return Decision(False, "too-new")
    if TV_TAG.search(entry.name):
        return Decision(True, "tv")
    movie = find_movie(entry.name)
    if movie is None:
        return Decision(False, "unknown-movie")
    library_path = (movie.get("movieFile") or {}).get("path") or ""
    if not library_path:
        return Decision(False, "not-imported")
    return Decision(True, "in-library", library_path)


def entry_name(storage: str, complete_dir: str) -> str:
    """The top-level Complete entry a SABnzbd storage path sits in, or "" outside it."""
    if not storage:
        return ""
    relative = posixpath.relpath(storage, complete_dir)
    if relative == "." or relative.startswith(".."):
        return ""
    return relative.split("/")[0]


def active_names(slots: Iterable[dict], complete_dir: str) -> Set[str]:
    """Complete entries SABnzbd is still post-processing.

    The storage path is exact even when SABnzbd renamed the final folder; the
    job name covers a slot that has no storage path yet.
    """
    unfinished = [slot for slot in slots if slot.get("status") not in FINISHED]
    names = {slot.get("name") or "" for slot in unfinished}
    names |= {entry_name(slot.get("storage") or "", complete_dir) for slot in unfinished}
    return names - {""}


def host_path(mounts: Dict[str, str], container_path: str) -> str:
    """Maps a path inside a container to the host, through its longest matching mount."""
    matches = [
        destination
        for destination in mounts
        if container_path == destination or container_path.startswith(destination.rstrip("/") + "/")
    ]
    if not matches:
        raise RuntimeError("no mount backs " + container_path)
    destination = max(matches, key=len)
    return mounts[destination] + container_path[len(destination):]


def size_and_newest(path: str):
    """Total file bytes under a path and the newest mtime of anything in it."""
    stat = os.lstat(path)
    if not os.path.isdir(path):
        return stat.st_size, stat.st_mtime
    total, newest = 0, stat.st_mtime
    for root, dirs, files in os.walk(path):
        for name in dirs:
            newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
        for name in files:
            found = os.lstat(os.path.join(root, name))
            total += found.st_size
            newest = max(newest, found.st_mtime)
    return total, newest


def scan(complete: str):
    """Every top-level entry in Complete, sorted by name."""
    entries = []
    for name in sorted(os.listdir(complete)):
        path = os.path.join(complete, name)
        is_link = os.path.islink(path)
        size, newest = (0, 0.0) if is_link else size_and_newest(path)
        entries.append(Entry(name, path, is_link, size, newest))
    return entries


def remove(path: str):
    """Deletes one entry. scan() already marked symlinks, so judge() never sends one here."""
    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def sweep(entries, decide: Callable[[Entry], Decision], apply: bool, log: logging.Logger, delete=remove):
    """Logs a decision per entry, deletes when applying, and returns the tallies."""
    verb = "deleted" if apply else "would delete"
    kept = collections.Counter()
    removed, freed, failed = 0, 0, 0
    for entry in entries:
        decision = decide(entry)
        if not decision.delete:
            kept[decision.reason] += 1
            log.info("kept         %-13s %s", decision.reason, entry.name)
            continue
        if apply:
            try:
                delete(entry.path)
            except OSError as error:
                failed += 1
                log.error("FAILED %s: %s", entry.name, error)
                continue
        removed += 1
        freed += entry.size
        detail = (" -> " + decision.detail) if decision.detail else ""
        log.info("%-12s %-13s %7.1fG %s%s", verb, decision.reason, entry.size / 1e9, entry.name, detail)
    reasons = ", ".join("%s %d" % pair for pair in sorted(kept.items())) or "none"
    log.info(
        "---- done: %s %d entries, %.2f TiB; kept %d (%s); failed %d",
        verb, removed, freed / 1024 ** 4, sum(kept.values()), reasons, failed,
    )
    return removed, failed


def get_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = 120):
    """GETs a URL and decodes its JSON body."""
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def read_key(path: str, pattern: str) -> str:
    """Pulls an API key out of a service's config file."""
    with open(path) as handle:
        found = re.search(pattern, handle.read(), re.M)
    if not found:
        raise RuntimeError("no API key in " + path)
    return found.group(1).strip()


def inspect(service: str, container_port: str) -> Service:
    """Finds the one running container for a compose service and reads its API URL and mounts."""
    ids = subprocess.check_output(
        [DOCKER, "ps", "-q", "--filter", "label=com.docker.compose.service=" + service], text=True
    ).split()
    if len(ids) != 1:
        raise RuntimeError("expected one running %s container, found %d" % (service, len(ids)))
    info = json.loads(subprocess.check_output([DOCKER, "inspect", ids[0]], text=True))[0]
    port = info["HostConfig"]["PortBindings"][container_port][0]["HostPort"]
    mounts = {mount["Destination"]: mount["Source"] for mount in info["Mounts"]}
    return Service("http://127.0.0.1:" + port, mounts)


def open_log() -> logging.Logger:
    """Logs to stdout for the Task Scheduler and to a rotating file beside the install."""
    log = logging.getLogger("sab-complete-cleanup")
    log.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S")
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    handlers = [
        logging.StreamHandler(sys.stdout),
        logging.handlers.RotatingFileHandler(LOG, maxBytes=2_000_000, backupCount=1),
    ]
    for handler in handlers:
        handler.setFormatter(formatter)
        log.addHandler(handler)
    return log


def main() -> int:
    """Discovers the stack, judges every Complete entry and sweeps."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="delete; without it, only report")
    parser.add_argument("--grace-hours", type=float, default=24)
    args = parser.parse_args()

    log = open_log()
    log.info("---- start (%s, grace %gh)", "APPLY" if args.apply else "DRY RUN", args.grace_hours)
    try:
        sab, radarr = inspect("sabnzbd", "8080/tcp"), inspect("radarr", "7878/tcp")
        sab_key = read_key(host_path(sab.mounts, "/config/sabnzbd.ini"), r"^api_key\s*=\s*(\S+)")
        radarr_headers = {"X-Api-Key": read_key(host_path(radarr.mounts, "/config/config.xml"), r"<ApiKey>([^<]+)</ApiKey>")}

        def sab_api(**query):
            return get_json(sab.url + "/api?" + urllib.parse.urlencode(dict(query, output="json", apikey=sab_key)), timeout=30)

        def find_movie(name):
            parsed = get_json(radarr.url + "/api/v3/parse?" + urllib.parse.urlencode({"title": name}), radarr_headers)
            return parsed.get("movie")

        get_json(radarr.url + "/api/v3/system/status", radarr_headers, timeout=30)
        complete_dir = sab_api(mode="get_config", section="misc")["config"]["misc"]["complete_dir"]
        active = active_names(sab_api(mode="history", limit=500)["history"]["slots"], complete_dir)
        cutoff = time.time() - args.grace_hours * 3600
        entries = scan(host_path(sab.mounts, complete_dir))
        _, failed = sweep(entries, lambda entry: judge(entry, active, cutoff, find_movie), args.apply, log)
    except Exception as error:  # any failure here means we cannot judge safely
        log.error("ABORT: %s", error)
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
