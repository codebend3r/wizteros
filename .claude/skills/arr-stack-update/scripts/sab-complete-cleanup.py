#!/usr/bin/env python3
"""Clear finished downloads out of Vermithor's SABnzbd Complete folder.

Runs on Vermithor as root (DSM Task Scheduler, daily 02:00). Radarr and Sonarr
remove what they grab after import, so anything left in Complete was sent to
SABnzbd some other way and nothing else will ever delete it.

Deletes an entry only when it is older than the grace period, SABnzbd is not
still working on it, and it is one of:
  - a TV release (an SxxEyy or Sxx season tag in the name)
  - a movie release whose title and year Radarr already has a file for

Everything else stays: a movie Radarr tracks without a file is the only copy
and wants importing, and an unknown movie is the owner's call.

Dry run by default; pass --apply to delete. Aborts without deleting anything
if Radarr cannot be read, since every movie verdict depends on it.
Python 3.8, which is what DSM 7.3 ships.
"""
import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from datetime import datetime

ESSOZ = "/volume1/docker/essoz"
COMPLETE = ESSOZ + "/downloads/Complete"
RADARR_CONFIG = ESSOZ + "/Radarr/config/config.xml"
SAB_CONFIG = ESSOZ + "/SABnzbd/config/sabnzbd.ini"
RADARR_URL = "http://127.0.0.1:7878"
SAB_URL = "http://127.0.0.1:27020"
LOG = ESSOZ + "/logs/sab-complete-cleanup.log"
LOG_KEEP_LINES = 20000

TV_TAG = re.compile(r"(^|[ ._-])S\d{1,4}(E\d{1,3})?([ ._-]|$)", re.I)
TITLE_YEAR = re.compile(r"(.+?)[ ._(\[]+((?:19|20)\d\d)(?:[ ._)\]]|$)")


def log(message):
    line = "%s %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line)
    with open(LOG, "a") as handle:
        handle.write(line + "\n")


def trim_log():
    with open(LOG) as handle:
        lines = handle.readlines()
    if len(lines) > LOG_KEEP_LINES:
        with open(LOG, "w") as handle:
            handle.writelines(lines[-LOG_KEEP_LINES:])


def read_key(path, pattern):
    with open(path) as handle:
        found = re.search(pattern, handle.read(), re.M)
    if not found:
        raise RuntimeError("no API key in " + path)
    return found.group(1).strip()


def get_json(url, headers=None, timeout=120):
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def norm(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def library_index():
    key = read_key(RADARR_CONFIG, r"<ApiKey>([^<]+)</ApiKey>")
    movies = get_json(RADARR_URL + "/api/v3/movie", {"X-Api-Key": key})
    if not isinstance(movies, list) or not movies:
        raise RuntimeError("Radarr returned no movies")
    index = {}
    for movie in movies:
        titles = [movie.get("title", "")]
        titles += [alt.get("title", "") for alt in movie.get("alternateTitles", [])]
        for title in titles:
            index.setdefault((norm(title), movie.get("year")), movie)
    return index


def sab_active():
    """Names SABnzbd is still downloading or post-processing."""
    key = read_key(SAB_CONFIG, r"^api_key\s*=\s*(\S+)")
    base = SAB_URL + "/api?output=json&apikey=" + key
    queue = get_json(base + "&mode=queue", timeout=30)
    history = get_json(base + "&mode=history&limit=500", timeout=30)
    names = {slot.get("filename", "") for slot in queue.get("queue", {}).get("slots", [])}
    names |= {
        slot.get("name", "")
        for slot in history.get("history", {}).get("slots", [])
        if slot.get("status") not in ("Completed", "Failed")
    }
    return names


def size_and_newest(path):
    stat = os.lstat(path)
    if not os.path.isdir(path):
        return stat.st_size, stat.st_mtime
    total, newest = 0, stat.st_mtime
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            entry = os.lstat(os.path.join(root, name))
            newest = max(newest, entry.st_mtime)
            if name in files:
                total += entry.st_size
    return total, newest


def verdict(name, index):
    if TV_TAG.search(name):
        return "tv", ""
    parsed = TITLE_YEAR.match(name)
    if not parsed:
        return None, ""
    movie = index.get((norm(parsed.group(1)), int(parsed.group(2))))
    if movie and movie.get("hasFile"):
        return "in-library", (movie.get("movieFile") or {}).get("path", "")
    return None, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="delete; without it, only report")
    parser.add_argument("--grace-hours", type=float, default=24)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    mode = "APPLY" if args.apply else "DRY RUN"
    log("---- start (%s, grace %gh)" % (mode, args.grace_hours))
    try:
        index = library_index()
        active = sab_active()
    except Exception as error:  # any failure here means we cannot judge safely
        log("ABORT: %s" % error)
        return 1

    cutoff = time.time() - args.grace_hours * 3600
    freed, removed, kept, failed = 0, 0, 0, 0
    for name in sorted(os.listdir(COMPLETE)):
        path = os.path.join(COMPLETE, name)
        if os.path.dirname(os.path.realpath(path)) != os.path.realpath(COMPLETE):
            continue
        kind, library_path = verdict(name, index)
        if not kind:
            kept += 1
            continue
        size, newest = size_and_newest(path)
        if name in active or newest > cutoff:
            kept += 1
            continue
        detail = (" -> " + library_path) if library_path else ""
        if args.apply:
            try:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
            except OSError as error:
                failed += 1
                log("FAILED %s: %s" % (name, error))
                continue
        removed += 1
        freed += size
        log("%s %-10s %7.1fG %s%s" % ("deleted" if args.apply else "would delete", kind, size / 1e9, name, detail))

    log("---- done: %s %d entries, %.2f TiB; kept %d; failed %d" % (
        "deleted" if args.apply else "would delete", removed, freed / 1024 ** 4, kept, failed))
    trim_log()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
