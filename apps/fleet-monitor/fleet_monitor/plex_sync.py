"""The play-history loop: Plex's own ledger, read into the store.

Two passes per host, both here and nowhere else. The history pass pages
`/status/sessions/history/all` from a cursor, enriches every newly seen item
from `/library/metadata`, and records one check against `plex:<host>`. The
inventory pass pages every movie, show and artist section so never-played has
something to diff against.

This is the only module that knows a Plex url. `probes.plex` parses, `plays`
stores, and the API composes; a request that fails here degrades one host for
one pass and nothing more. Every page commits in its own session with the
cursor it advanced, so a pass that dies mid-backfill resumes from the last
page that landed rather than starting the year over.

Tautulli's answer to the same question is a websocket that has to be listening
when a play happens, and it cannot see anything from before it was installed.
The ledger already exists on every server, so it is read instead of guessed.
"""

import asyncio
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fleet_monitor import config, db, incidents, plays
from fleet_monitor.config import Host
from fleet_monitor.incidents import CheckResult
from fleet_monitor.probes import plex
from fleet_monitor.tasks import log_raised
from fleet_monitor.transport import http

log = logging.getLogger("fleet.plex")

# Measured 2026-09-18: 500 history rows answer in a tenth of a second and a
# thousand episodes in one to ten, so these are sized for few round trips
# rather than for the server's ceiling.
HISTORY_PAGE = 500
LIBRARY_PAGE = 1000
# Keys per metadata request. Twenty-five answered in under a second on every
# box; fifty was the batch that took twelve seconds on caraxes under load,
# and a metadata answer is the heaviest thing per item this loop asks for.
METADATA_BATCH = 25

# How far behind the cursor a pass re-reads. Inserts are idempotent on the
# server's own history id, so the overlap costs one cheap page and buys back
# anything a collector outage or a clock step left out.
OVERLAP = timedelta(days=2)

# Wide, on purpose. The first live round timed out at twenty seconds on the
# two slowest boxes while they were also serving streams; the same requests
# answered in a second once they were idle. A dead server fails the connect
# long before this, so the width only ever costs a busy one its patience.
TIMEOUT = 90.0

# The incident machine's tolerance for silence between checks. Three history
# intervals, so one slow round does not read as the collector having stopped
# watching and reset the streak that opens an incident.
CHECK_GAP = timedelta(seconds=config.PLEX_HISTORY_INTERVAL * 3)


@dataclass(frozen=True, slots=True)
class Fetched:
    """One Plex answer, decoded, or the reason there is none. `reason` is
    empty on success and otherwise names the transport failure the way the
    docker endpoint's checks do, plus `bad_json` for a 200 nothing could parse."""

    payload: object | None
    reason: str


@dataclass(frozen=True, slots=True)
class HostOutcome:
    """What one round did for one host: whether the history pass succeeded and
    whether an inventory ran to completion. Only the loop reads it, to decide
    when the next inventory is due."""

    history_ok: bool
    inventory_ran: bool
    inventory_complete: bool


def _secure(host: Host) -> bool:
    return host.plex_url.startswith("https://")


async def fetch(
    host: Host,
    path: str,
    *,
    token: str,
    params: dict[str, str] | None = None,
    start: int | None = None,
    size: int | None = None,
    timeout: float | None = None,
) -> Fetched:
    """GET one Plex path as JSON, never raising. `timeout` is the whole
    request's budget in seconds, TIMEOUT unless a caller narrows it.

    Paging travels in the two container headers, the way every Plex client
    sends it. The query keeps `>` and `:` literal because `viewedAt>=` and
    `viewedAt:asc` are how the server spells its own filters.

    Verification is off for the two servers that insist on https: they present
    Plex's wildcard certificate on a LAN address, which no verifier accepts,
    and the token is what authorizes the request on either transport.
    """
    budget = TIMEOUT if timeout is None else timeout
    query = urlencode(params or {}, safe=">:,")
    url = f"{host.plex_url}{path}" + (f"?{query}" if query else "")
    headers = {"X-Plex-Token": token, "Accept": "application/json"}
    if start is not None:
        headers["X-Plex-Container-Start"] = str(start)
    if size is not None:
        headers["X-Plex-Container-Size"] = str(size)
    # The transport's own timeout is per read, not per request: a server that
    # keeps trickling bytes never trips it. vermithor answered one listing
    # page's headers at once and then took fifty-nine minutes over its body
    # (2026-09-18), and a loop with five servers to visit every five minutes
    # cannot wait on one of them for an hour. The whole request gets the
    # budget, headers to last byte.
    try:
        result = await asyncio.wait_for(
            http.get_json(url, timeout=budget, headers=headers, verify=not _secure(host)),
            timeout=budget,
        )
    except TimeoutError:
        return Fetched(payload=None, reason="timeout")
    if not result.ok:
        return Fetched(payload=None, reason=result.reason)
    try:
        return Fetched(payload=json.loads(result.body), reason="")
    except json.JSONDecodeError:
        return Fetched(payload=None, reason="bad_json")


def _failed(path: str, host: Host, at: datetime, reason: str) -> CheckResult:
    """Record a history pass that could not complete, against the server it
    could not read. The rows already committed stay: a pass that died on page
    four keeps pages one to three, and the cursor says so."""
    check = CheckResult(target=f"plex:{host.name}", ok=False, reason=reason)
    with db.session(path) as connection:
        plays.mark_history(connection, host.name, at=at, ok=False, error=reason)
        incidents.record(connection, check, at, gap=CHECK_GAP)
    log.warning("play history for %s failed: %s", host.name, reason)
    return check


async def _page_history(
    host: Host, path: str, *, token: str, since: int, page_size: int
) -> str:
    """Page the ledger from `since` upward, committing each page with the
    cursor it advanced. Returns the failure reason, or empty when the last
    page landed.

    Ascending, so the cursor only ever moves forward and a page that commits
    is a page nobody has to read again. A play landing on the server while
    the pass runs appends past the last page rather than shifting the pages
    already read.
    """
    start = 0
    while True:
        fetched = await fetch(
            host,
            "/status/sessions/history/all",
            token=token,
            params={"sort": "viewedAt:asc", "viewedAt>": str(since)},
            start=start,
            size=page_size,
        )
        if fetched.payload is None:
            return fetched.reason
        entries = plex.parse_history(fetched.payload)
        info = plex.page_info(fetched.payload)
        with db.session(path) as connection:
            inserted = plays.insert_plays(connection, host.name, entries)
            if entries:
                plays.set_history_cursor(
                    connection, host.name, max(entry.viewed_at for entry in entries)
                )
        if inserted:
            log.info("play history for %s: %d new plays", host.name, inserted)
        if info is None or info.size == 0 or start + info.size >= info.total_size:
            return ""
        start += info.size


async def enrich_items(host: Host, path: str, *, token: str, now: datetime) -> str:
    """Give every played item with no row one: titles for the page, quality
    for the buckets. Returns the failure reason, or empty when nothing is
    missing.

    Keys the server does not answer for get a stub, so a deleted film is asked
    about once rather than on every pass. Each batch shrinks the missing set,
    so this always terminates.
    """
    while True:
        with db.session(path) as connection:
            keys = plays.missing_item_keys(connection, host.name, limit=METADATA_BATCH)
        if not keys:
            return ""
        fetched = await fetch(host, f"/library/metadata/{','.join(keys)}", token=token)
        if fetched.reason == "timeout":
            # One key can stall a whole batch, and the batch is retried in the
            # same order on every pass, so a stalled key would block every
            # item behind it forever. Ask for each alone: the ones that answer
            # are kept, the one that stalls on its own is stubbed and named,
            # and the next inventory restores it if the library still has it.
            reason = await _enrich_singly(host, path, token=token, now=now, keys=keys)
            if reason:
                return reason
            continue
        # a 404 is the server saying none of these exist any more; anything
        # else is the server not answering, which is not the same fact
        if fetched.payload is None and fetched.reason != "http_404":
            return fetched.reason
        _store_answered(path, host, now=now, keys=keys, payload=fetched.payload)


def _store_answered(
    path: str, host: Host, *, now: datetime, keys: Sequence[str], payload: object | None
) -> None:
    """Keep what a metadata request described and stub what it did not."""
    items = plex.parse_items(payload) if payload is not None else ()
    answered = {item.rating_key for item in items}
    with db.session(path) as connection:
        plays.upsert_items(connection, host.name, items, seen_at=now)
        plays.stub_missing_items(
            connection, host.name, [key for key in keys if key not in answered], seen_at=now
        )


async def _enrich_singly(
    host: Host, path: str, *, token: str, now: datetime, keys: Sequence[str]
) -> str:
    """The fallback for a batch that stalled: one request per key. A key that
    stalls alone is stubbed as absent so the loop moves past it; any other
    failure is the server not answering and ends the pass as usual."""
    for key in keys:
        fetched = await fetch(host, f"/library/metadata/{key}", token=token)
        if fetched.reason == "timeout":
            log.warning("metadata for %s item %s stalled on its own; stubbed", host.name, key)
            _store_answered(path, host, now=now, keys=(key,), payload=None)
            continue
        if fetched.payload is None and fetched.reason != "http_404":
            return fetched.reason
        _store_answered(path, host, now=now, keys=(key,), payload=fetched.payload)
    return ""


async def sync_history(
    host: Host,
    path: str,
    *,
    now: datetime,
    token: str,
    lookback_days: int,
    page_size: int = HISTORY_PAGE,
    enrich: bool = True,
) -> CheckResult | None:
    """One host's history pass. None for a host without Plex; otherwise the
    check that was recorded, which is the pass's outcome.

    The order matters: the server is identified first, so a pass that fails
    at the first request still leaves a named row on /plays/sync; identities
    are refreshed next, best effort, so a viewer's name is known before their
    plays are shown; then the ledger, then the items behind it.

    `enrich` is off on a round that is about to take the inventory: the
    listing describes every item still in the library far more cheaply than
    the metadata endpoint does, so the round enriches only what the listing
    left out, afterwards.
    """
    if not host.plex_url:
        return None
    if not token:
        return _failed(path, host, now, "no_token")

    root = await fetch(host, "/", token=token)
    if root.payload is None:
        return _failed(path, host, now, root.reason)
    info = plex.parse_server(root.payload)
    if info is None:
        return _failed(path, host, now, "bad_json")
    with db.session(path) as connection:
        plays.upsert_server(connection, host.name, info=info)
        cursor = plays.history_cursor(connection, host.name)

    accounts = await fetch(host, "/accounts", token=token)
    devices = await fetch(host, "/devices", token=token)
    with db.session(path) as connection:
        if accounts.payload is not None:
            plays.upsert_accounts(connection, host.name, plex.parse_accounts(accounts.payload))
        if devices.payload is not None:
            plays.upsert_devices(connection, host.name, plex.parse_devices(devices.payload))

    since = (
        cursor - int(OVERLAP.total_seconds())
        if cursor is not None
        else int((now - timedelta(days=lookback_days)).timestamp())
    )
    reason = await _page_history(host, path, token=token, since=since, page_size=page_size)
    if reason:
        return _failed(path, host, now, reason)
    if enrich:
        reason = await enrich_items(host, path, token=token, now=now)
        if reason:
            return _failed(path, host, now, reason)

    check = CheckResult(target=f"plex:{host.name}", ok=True, reason="")
    with db.session(path) as connection:
        plays.mark_history(connection, host.name, at=now, ok=True, error=None)
        incidents.record(connection, check, now, gap=CHECK_GAP)
    return check


async def _page_section(
    host: Host,
    path: str,
    *,
    token: str,
    section: plex.Section,
    now: datetime,
    page_size: int,
) -> str:
    """Every leaf item of one section, a page per session, all stamped with
    this run. Returns the failure reason, or empty when the last page landed."""
    start = 0
    leaf = str(plex.LEAF_TYPE[section.kind])
    while True:
        fetched = await fetch(
            host,
            f"/library/sections/{section.section_id}/all",
            token=token,
            params={"type": leaf, "includeGuids": "0"},
            start=start,
            size=page_size,
        )
        if fetched.payload is None:
            return fetched.reason
        # the listing does not name its own section on each row
        items = plex.parse_items(fetched.payload, section_id=section.section_id)
        info = plex.page_info(fetched.payload)
        with db.session(path) as connection:
            plays.upsert_items(connection, host.name, items, seen_at=now)
        if info is None or info.size == 0 or start + info.size >= info.total_size:
            return ""
        start += info.size


async def sync_library(
    host: Host,
    path: str,
    *,
    now: datetime,
    token: str,
    page_size: int = LIBRARY_PAGE,
) -> bool:
    """One host's inventory pass. True when every section paged to its end.

    Items are retired only after a complete run. A section that failed on
    page three left its remaining items unseen this run, and retiring them
    would make a third of a library look deleted because a request timed out.
    """
    if not host.plex_url or not token:
        return False
    sections = await fetch(host, "/library/sections", token=token)
    if sections.payload is None:
        with db.session(path) as connection:
            plays.mark_library(connection, host.name, at=now, ok=False, error=sections.reason)
        log.warning("inventory for %s failed: %s", host.name, sections.reason)
        return False
    parsed = plex.parse_sections(sections.payload)
    with db.session(path) as connection:
        plays.upsert_sections(connection, host.name, parsed)

    failure = ""
    for section in parsed:
        reason = await _page_section(
            host, path, token=token, section=section, now=now, page_size=page_size
        )
        if reason:
            log.warning("inventory for %s stopped in %r: %s", host.name, section.title, reason)
            failure = reason
    complete = not failure
    with db.session(path) as connection:
        if complete:
            retired = plays.retire_unseen_items(connection, host.name, seen_before=now)
            if retired:
                log.info("inventory for %s retired %d items", host.name, retired)
        plays.mark_library(connection, host.name, at=now, ok=complete, error=failure or None)
    return complete


async def sync_host(
    host: Host,
    path: str,
    *,
    now: datetime,
    token: str,
    lookback_days: int,
    inventory_due: bool,
) -> HostOutcome:
    """One host's round: history always, inventory when due and only after a
    history pass that reached the server. Sequential within the host, so one
    server never answers two of this loop's requests at once.

    On an inventory round the played items are enriched after the listing
    rather than before it. On a fresh database that is the difference between
    asking the metadata endpoint about every item ever played and asking it
    about the handful the library no longer holds.
    """
    check = await sync_history(
        host, path, now=now, token=token, lookback_days=lookback_days, enrich=not inventory_due
    )
    history_ok = check is not None and check.ok
    if not (inventory_due and history_ok):
        return HostOutcome(history_ok=history_ok, inventory_ran=False, inventory_complete=False)
    complete = await sync_library(host, path, now=now, token=token)
    reason = await enrich_items(host, path, token=token, now=now)
    if reason:
        # the ledger and the library both landed; what is missing is the
        # detail of a few deleted items, which the next pass asks for again
        log.warning("enrichment for %s stopped: %s", host.name, reason)
    return HostOutcome(history_ok=history_ok, inventory_ran=True, inventory_complete=complete)


def plex_hosts() -> tuple[Host, ...]:
    return tuple(host for host in config.HOSTS if host.plex_url)


def init_db(path: str) -> None:
    """Every table a pass writes: the ledger and the incident machine it
    records its checks into. Both, because this loop can be the first thing
    to run against a fresh file (`run_once`, or the loop started alone), and
    a pass that backfilled a year and then died on a missing check table
    would leave the server marked as never reached."""
    with db.session(path) as connection:
        plays.init_db(connection)
        incidents.init_db(connection)


async def run_round(path: str, *, now: datetime, inventory_due: set[str]) -> dict[str, HostOutcome]:
    """Every Plex host concurrently. The token is read per round rather than
    once at start, so a token added to the env after boot is picked up by the
    next pass without a restart."""
    token = config.plex_token()
    lookback = config.plex_lookback_days()
    hosts = plex_hosts()
    outcomes = await asyncio.gather(
        *(
            sync_host(
                host,
                path,
                now=now,
                token=token,
                lookback_days=lookback,
                inventory_due=host.name in inventory_due,
            )
            for host in hosts
        ),
        return_exceptions=True,
    )
    completed = log_raised("play history", outcomes)
    return {host.name: outcome for host, outcome in zip(hosts, outcomes) if outcome in completed}


async def run_forever(path: str) -> None:
    """History every PLEX_HISTORY_INTERVAL, an inventory per host every
    PLEX_LIBRARY_INTERVAL, the first one on the first round.

    A failed inventory is retried on the next history round rather than in
    six hours: the failure was one request, and a library that never gets
    counted is a never-played list that never appears.
    """
    init_db(path)
    if not config.plex_token():
        log.warning("no Plex token in FM_PLEX_TOKEN or PLEX_TOKEN; play history idles until one appears")
    loop = asyncio.get_running_loop()
    due = loop.time()
    inventory_next: dict[str, float] = {host.name: 0.0 for host in plex_hosts()}
    while True:
        now = datetime.now(tz=timezone.utc)
        inventory_due = {name for name, at in inventory_next.items() if loop.time() >= at}
        outcomes = await run_round(path, now=now, inventory_due=inventory_due)
        for name, outcome in outcomes.items():
            if outcome.inventory_complete:
                inventory_next[name] = loop.time() + config.PLEX_LIBRARY_INTERVAL
        # measured from when the round was due, not from when it finished, so a
        # long first backfill is absorbed rather than added to every interval
        due += config.PLEX_HISTORY_INTERVAL
        await asyncio.sleep(max(0.0, due - loop.time()))


async def run_once(path: str) -> dict[str, HostOutcome]:
    """One round with the inventory on every host, for a first fill by hand
    or a smoke test. The same code the loop runs, minus the sleeping."""
    init_db(path)
    return await run_round(
        path,
        now=datetime.now(tz=timezone.utc),
        inventory_due={host.name for host in plex_hosts()},
    )


if __name__ == "__main__":
    # `python -m fleet_monitor.plex_sync` runs one round and exits; the
    # collector's own entrypoint is what runs it forever beside the vitals.
    logging.basicConfig(level=logging.INFO)
    for name, result in asyncio.run(run_once(config.db_path())).items():
        print(name, result)
