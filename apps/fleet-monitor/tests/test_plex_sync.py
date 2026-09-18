import asyncio
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from fleet_monitor import collector, config, incidents, plays, plex_sync
from fleet_monitor import db as fleet_db
from fleet_monitor.probes import plex
from fleet_monitor.transport.http import HttpResult

T0 = datetime(2026, 9, 18, 12, 0, 0, tzinfo=timezone.utc)
NOW = int(T0.timestamp())
DAY = 86_400

# Every url is deliberately unresolvable: the transport is faked in every
# test, so a leaked real request fails loudly instead of touching the LAN.
HOST = config.Host(
    name="syrax", ip="192.0.2.5", has_gpu=False, docker_url="",
    plex_url="http://plex.invalid:32400",
)
SECURE_HOST = config.Host(
    name="vhagar", ip="192.0.2.6", has_gpu=True, docker_url="",
    plex_url="https://plex.invalid:32400",
)
NO_PLEX = config.Host(name="ghost", ip="192.0.2.9", has_gpu=False, docker_url="")

ROOT = {
    "MediaContainer": {
        "friendlyName": "Syrax", "machineIdentifier": "2fae773f4398", "version": "1.43.4",
    }
}
ACCOUNTS = {
    "MediaContainer": {"Account": [{"id": 1, "name": "cj"}, {"id": 42, "name": "Ann", "thumb": "/a"}]}
}
DEVICES = {
    "MediaContainer": {
        "Device": [{"id": 7, "name": "Chrome", "platform": "Chrome", "clientIdentifier": "c1"}]
    }
}
SECTIONS = [
    {"key": "8", "type": "movie", "title": "Films"},
    {"key": "6", "type": "show", "title": "Shows"},
    {"key": "99", "type": "photo", "title": "Photos"},
]


def _play(history_id, rating_key, *, viewed_at, kind="movie", title="Heat", account=1):
    return {
        "historyKey": f"/status/sessions/history/{history_id}",
        "ratingKey": rating_key,
        "type": kind,
        "title": title,
        "librarySectionID": "8",
        "viewedAt": viewed_at,
        "accountID": account,
        "deviceID": 7,
    }


def _movie(rating_key, title, *, resolution="1080", width=1920):
    return {
        "ratingKey": rating_key,
        "type": "movie",
        "title": title,
        "year": 1995,
        "librarySectionID": "8",
        "duration": 6_000_000,
        "addedAt": NOW - 30 * DAY,
        "thumb": f"/thumb/{rating_key}",
        "Media": [{"videoResolution": resolution, "width": width, "height": 800}],
    }


def _episode(rating_key, title):
    return {
        "ratingKey": rating_key,
        "type": "episode",
        "title": title,
        "index": 1,
        "parentIndex": 4,
        "parentRatingKey": "510",
        "parentTitle": "Season 4",
        "grandparentRatingKey": "500",
        "grandparentTitle": "Better Call Saul",
        "librarySectionID": "6",
        "duration": 2_800_000,
        "addedAt": NOW - 3 * DAY,
        "Media": [{"videoResolution": "1080", "width": 1920, "height": 1080}],
    }


def _container(rows, *, total=None, offset=0):
    return {
        "MediaContainer": {
            "size": len(rows),
            "totalSize": len(rows) if total is None else total,
            "offset": offset,
            "Metadata": rows,
        }
    }


class FakePlex:
    """A Plex server standing behind http.get_json.

    Pages the ledger and the sections the way the real one does, off the two
    container headers and the `viewedAt>` filter, and refuses whatever a test
    puts in `refuse`. `history_budget` answers that many ledger pages and then
    refuses, which is how a pass that dies mid-backfill is staged.
    """

    def __init__(self, *, history=(), items=None, sections=(), section_items=None):
        self.history = sorted(history, key=lambda row: row["viewedAt"])
        self.items = dict(items or {})
        self.sections = list(sections)
        self.section_items = dict(section_items or {})
        self.refuse: set[str] = set()
        # paths (substrings) whose answer trickles past any budget a test sets
        self.stall: set[str] = set()
        self.history_budget: int | None = None
        self.requests: list[tuple[str, dict, dict]] = []

    async def get_json(self, url, *, timeout=8.0, headers=None, verify=True):
        parts = urlsplit(url)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        sent = dict(headers or {})
        self.requests.append((parts.path, query, {**sent, "verify": verify}))
        if parts.path in self.refuse:
            return HttpResult(ok=False, status=0, body="", reason="refused")
        if any(marker in parts.path for marker in self.stall):
            await asyncio.sleep(1)
        if parts.path == "/status/sessions/history/all" and self.history_budget is not None:
            if self.history_budget <= 0:
                return HttpResult(ok=False, status=0, body="", reason="refused")
            self.history_budget -= 1
        start = int(sent.get("X-Plex-Container-Start", "0"))
        size = int(sent.get("X-Plex-Container-Size", "1000000"))
        body = self._answer(parts.path, query, start, size)
        if body is None:
            return HttpResult(ok=False, status=404, body="", reason="http_404")
        return HttpResult(ok=True, status=200, body=json.dumps(body), reason="")

    def _answer(self, path, query, start, size):
        if path == "/":
            return ROOT
        if path == "/accounts":
            return ACCOUNTS
        if path == "/devices":
            return DEVICES
        if path == "/status/sessions/history/all":
            since = int(query.get("viewedAt>", "0"))
            rows = [row for row in self.history if row["viewedAt"] >= since]
            return _container(rows[start : start + size], total=len(rows), offset=start)
        if path.startswith("/library/metadata/"):
            keys = path.rsplit("/", 1)[1].split(",")
            found = [self.items[key] for key in keys if key in self.items]
            return _container(found) if found else None
        if path == "/library/sections":
            return {"MediaContainer": {"Directory": self.sections}}
        if path.startswith("/library/sections/") and path.endswith("/all"):
            rows = self.section_items.get(path.split("/")[3], [])
            return _container(rows[start : start + size], total=len(rows), offset=start)
        return None


@pytest.fixture
def path(tmp_path):
    db = str(tmp_path / "fleet.db")
    collector.init_db(db)
    return db


def _fake(monkeypatch, fake: FakePlex) -> FakePlex:
    monkeypatch.setattr(plex_sync.http, "get_json", fake.get_json)
    return fake


def _rows(path, sql, params=()):
    with fleet_db.session(path) as connection:
        return [tuple(row) for row in connection.execute(sql, params).fetchall()]


def _status(path, host=HOST):
    with fleet_db.session(path) as connection:
        return plays.sync_status(connection, hosts=((host.name, host.plex_url),))[0]


def _cursor(path, host=HOST):
    with fleet_db.session(path) as connection:
        return plays.history_cursor(connection, host.name)


def _seen_earlier(path, item):
    with fleet_db.session(path) as connection:
        plays.upsert_items(
            connection,
            "syrax",
            plex.parse_items(_container([item])),
            seen_at=T0 - timedelta(hours=6),
        )


async def test_the_first_pass_backfills_the_ledger_in_pages_and_enriches_its_items(
    path, monkeypatch
):
    fake = _fake(
        monkeypatch,
        FakePlex(
            history=[
                _play(1, "100", viewed_at=NOW - 10 * DAY),
                _play(2, "101", viewed_at=NOW - 5 * DAY, title="Ronin"),
                _play(3, "100", viewed_at=NOW - DAY, account=42),
            ],
            # 101 is gone from the library: the ledger remembers it, the
            # metadata endpoint does not
            items={"100": _movie("100", "Heat")},
        ),
    )

    check = await plex_sync.sync_history(
        HOST, path, now=T0, token="tok", lookback_days=365, page_size=2
    )

    assert check == incidents.CheckResult(target="plex:syrax", ok=True, reason="")
    pages = [(q, h) for p, q, h in fake.requests if p == "/status/sessions/history/all"]
    assert [h["X-Plex-Container-Start"] for _, h in pages] == ["0", "2"]
    assert all(h["X-Plex-Container-Size"] == "2" for _, h in pages)
    # a year back, ascending, with the token and the json accept on every page
    assert all(q == {"sort": "viewedAt:asc", "viewedAt>": str(NOW - 365 * DAY)} for q, _ in pages)
    assert all(h["X-Plex-Token"] == "tok" and h["Accept"] == "application/json" for _, h in pages)

    assert _rows(path, "SELECT history_id, rating_key, account_id FROM plex_plays ORDER BY 1") == [
        (1, "100", 1),
        (2, "101", 1),
        (3, "100", 42),
    ]
    assert _cursor(path) == NOW - DAY
    status = _status(path)
    assert (status.friendly_name, status.reachable, status.history_synced_at, status.plays) == (
        "Syrax", True, T0, 3,
    )
    # the played film got its metadata; the vanished one got a stub carrying
    # the ledger's own title, absent and unranked, and will not be asked again
    assert _rows(path, "SELECT rating_key, title, present, quality FROM plex_items ORDER BY 1") == [
        ("100", "Heat", 1, "1080p"),
        ("101", "Ronin", 0, None),
    ]
    assert _rows(path, "SELECT account_id, name FROM plex_accounts ORDER BY 1") == [
        (1, "cj"), (42, "Ann"),
    ]
    assert _rows(path, "SELECT device_id, name FROM plex_devices") == [(7, "Chrome")]


async def test_a_later_pass_resumes_from_the_cursor_with_an_overlap_and_stays_idempotent(
    path, monkeypatch
):
    fake = _fake(
        monkeypatch,
        FakePlex(
            history=[_play(1, "100", viewed_at=NOW - 10 * DAY)],
            items={"100": _movie("100", "Heat")},
        ),
    )
    await plex_sync.sync_history(HOST, path, now=T0, token="tok", lookback_days=365)
    fake.history.append(_play(2, "100", viewed_at=NOW - DAY))
    fake.requests.clear()

    check = await plex_sync.sync_history(
        HOST, path, now=T0 + timedelta(minutes=5), token="tok", lookback_days=365
    )

    assert check is not None and check.ok
    since = next(q["viewedAt>"] for p, q, _ in fake.requests if p == "/status/sessions/history/all")
    # the cursor minus the overlap, not the lookback: the year is read once
    assert since == str(NOW - 10 * DAY - 2 * DAY)
    # the overlap re-read the first play and inserted nothing twice
    assert _rows(path, "SELECT history_id FROM plex_plays ORDER BY 1") == [(1,), (2,)]
    assert _cursor(path) == NOW - DAY
    # nothing was missing, so nothing was asked about
    assert [p for p, _, _ in fake.requests if p.startswith("/library/metadata/")] == []


async def test_a_pass_that_dies_mid_backfill_keeps_the_pages_that_landed(path, monkeypatch):
    fake = _fake(
        monkeypatch,
        FakePlex(
            history=[_play(i, "100", viewed_at=NOW - i * DAY) for i in (1, 2, 3, 4)],
            items={"100": _movie("100", "Heat")},
        ),
    )
    fake.history_budget = 1

    check = await plex_sync.sync_history(
        HOST, path, now=T0, token="tok", lookback_days=365, page_size=2
    )

    assert check == incidents.CheckResult(target="plex:syrax", ok=False, reason="refused")
    # ascending, so the oldest two landed and the cursor stands on them: the
    # next pass starts there rather than at the start of the year
    assert _rows(path, "SELECT history_id FROM plex_plays ORDER BY 1") == [(3,), (4,)]
    assert _cursor(path) == NOW - 3 * DAY
    status = _status(path)
    assert (status.reachable, status.last_error, status.history_synced_at) == (False, "refused", T0)


async def test_no_token_records_the_failure_without_touching_the_server(path, monkeypatch):
    fake = _fake(monkeypatch, FakePlex())

    check = await plex_sync.sync_history(HOST, path, now=T0, token="", lookback_days=365)

    assert check == incidents.CheckResult(target="plex:syrax", ok=False, reason="no_token")
    assert fake.requests == []
    status = _status(path)
    assert (status.reachable, status.last_error, status.history_synced_at) == (False, "no_token", T0)


async def test_a_server_that_refuses_is_recorded_and_read_no_further(path, monkeypatch):
    fake = _fake(monkeypatch, FakePlex())
    fake.refuse.add("/")

    check = await plex_sync.sync_history(HOST, path, now=T0, token="tok", lookback_days=365)

    assert check == incidents.CheckResult(target="plex:syrax", ok=False, reason="refused")
    assert [p for p, _, _ in fake.requests] == ["/"]
    with fleet_db.session(path) as connection:
        assert {i.target for i in incidents.open_incidents(connection)} == set()
    # a second failure, one interval later, is what opens the incident
    await plex_sync.sync_history(
        HOST, path, now=T0 + timedelta(seconds=config.PLEX_HISTORY_INTERVAL),
        token="tok", lookback_days=365,
    )
    with fleet_db.session(path) as connection:
        assert {i.target for i in incidents.open_incidents(connection)} == {"plex:syrax"}


async def test_a_host_without_plex_is_skipped_entirely(path, monkeypatch):
    fake = _fake(monkeypatch, FakePlex())

    assert await plex_sync.sync_history(NO_PLEX, path, now=T0, token="tok", lookback_days=365) is None
    assert await plex_sync.sync_library(NO_PLEX, path, now=T0, token="tok") is False
    assert fake.requests == []


async def test_the_secure_servers_are_read_without_certificate_verification(path, monkeypatch):
    fake = _fake(monkeypatch, FakePlex())

    await plex_sync.sync_history(SECURE_HOST, path, now=T0, token="tok", lookback_days=365)
    assert {h["verify"] for _, _, h in fake.requests} == {False}
    fake.requests.clear()

    await plex_sync.sync_history(HOST, path, now=T0, token="tok", lookback_days=365)
    assert {h["verify"] for _, _, h in fake.requests} == {True}


async def test_items_the_server_no_longer_has_are_stubbed_once(path, monkeypatch):
    fake = _fake(
        monkeypatch,
        FakePlex(history=[_play(1, "777", viewed_at=NOW - DAY, title="Vanished")]),
    )
    await plex_sync.sync_history(HOST, path, now=T0, token="tok", lookback_days=365)
    fake.requests.clear()

    await plex_sync.sync_history(
        HOST, path, now=T0 + timedelta(minutes=5), token="tok", lookback_days=365
    )

    assert [p for p, _, _ in fake.requests if p.startswith("/library/metadata/")] == []
    assert _rows(path, "SELECT title, present, quality FROM plex_items WHERE rating_key = '777'") == [
        ("Vanished", 0, None)
    ]


async def test_a_complete_inventory_upserts_every_section_and_retires_what_is_gone(
    path, monkeypatch
):
    fake = _fake(
        monkeypatch,
        FakePlex(
            sections=SECTIONS,
            section_items={
                "8": [_movie("100", "Heat"), _movie("102", "Ronin")],
                "6": [_episode("600", "Smoke")],
            },
        ),
    )
    # an item a previous run saw that the library no longer lists
    _seen_earlier(path, _movie("103", "Gone"))

    complete = await plex_sync.sync_library(HOST, path, now=T0, token="tok", page_size=1)

    assert complete is True
    listed = [
        (p, h["X-Plex-Container-Start"], q["type"]) for p, q, h in fake.requests if p.endswith("/all")
    ]
    # movies by type 1, episodes by type 4, a page per item at this size, and
    # the photo section never asked for
    assert listed == [
        ("/library/sections/8/all", "0", "1"),
        ("/library/sections/8/all", "1", "1"),
        ("/library/sections/6/all", "0", "4"),
    ]
    assert _rows(path, "SELECT rating_key, present FROM plex_items ORDER BY 1") == [
        ("100", 1), ("102", 1), ("103", 0), ("600", 1),
    ]
    assert _rows(path, "SELECT section_id, kind, title FROM plex_sections ORDER BY 1") == [
        ("6", "episode", "Shows"), ("8", "movie", "Films"),
    ]
    status = _status(path)
    assert (status.library_synced_at, status.items) == (T0, 3)


async def test_a_partial_inventory_retires_nothing(path, monkeypatch):
    fake = _fake(
        monkeypatch,
        FakePlex(
            sections=SECTIONS,
            section_items={"8": [_movie("100", "Heat")], "6": [_episode("600", "Smoke")]},
        ),
    )
    fake.refuse.add("/library/sections/6/all")
    _seen_earlier(path, _movie("103", "Gone"))

    complete = await plex_sync.sync_library(HOST, path, now=T0, token="tok")

    assert complete is False
    # Gone stays present: the run could not vouch for the shows section, so it
    # cannot say what is missing from the films either
    assert _rows(path, "SELECT rating_key, present FROM plex_items ORDER BY 1") == [
        ("100", 1), ("103", 1),
    ]
    status = _status(path)
    assert (status.library_synced_at, status.last_error) == (T0, "refused")


async def test_a_sections_listing_that_fails_marks_the_pass(path, monkeypatch):
    fake = _fake(monkeypatch, FakePlex(sections=SECTIONS))
    fake.refuse.add("/library/sections")

    assert await plex_sync.sync_library(HOST, path, now=T0, token="tok") is False
    assert _status(path).last_error == "refused"


async def test_sync_host_runs_the_inventory_only_after_a_history_pass_reached_the_server(
    path, monkeypatch
):
    fake = _fake(
        monkeypatch, FakePlex(sections=SECTIONS, section_items={"8": [_movie("100", "Heat")]})
    )

    due = await plex_sync.sync_host(
        HOST, path, now=T0, token="tok", lookback_days=365, inventory_due=True
    )
    assert due == plex_sync.HostOutcome(history_ok=True, inventory_ran=True, inventory_complete=True)

    fake.requests.clear()
    not_due = await plex_sync.sync_host(
        HOST, path, now=T0, token="tok", lookback_days=365, inventory_due=False
    )
    assert not_due.inventory_ran is False
    assert "/library/sections" not in {p for p, _, _ in fake.requests}

    fake.refuse.add("/")
    unreachable = await plex_sync.sync_host(
        HOST, path, now=T0, token="tok", lookback_days=365, inventory_due=True
    )
    assert unreachable == plex_sync.HostOutcome(
        history_ok=False, inventory_ran=False, inventory_complete=False
    )


async def test_run_round_fans_out_over_the_configured_plex_hosts(path, monkeypatch):
    _fake(
        monkeypatch,
        FakePlex(
            history=[_play(1, "100", viewed_at=NOW - DAY)],
            items={"100": _movie("100", "Heat")},
            sections=SECTIONS,
            section_items={"8": [_movie("100", "Heat")]},
        ),
    )
    monkeypatch.setattr(config, "HOSTS", (HOST, SECURE_HOST, NO_PLEX))
    monkeypatch.setenv("FM_PLEX_TOKEN", "tok")

    outcomes = await plex_sync.run_round(path, now=T0, inventory_due={"syrax"})

    assert set(outcomes) == {"syrax", "vhagar"}
    assert outcomes["syrax"].inventory_ran and outcomes["syrax"].inventory_complete
    assert outcomes["vhagar"].history_ok and not outcomes["vhagar"].inventory_ran
    assert _rows(path, "SELECT DISTINCT host FROM plex_plays ORDER BY 1") == [("syrax",), ("vhagar",)]


async def test_run_once_inventories_every_host_and_creates_what_it_writes(tmp_path, monkeypatch):
    _fake(monkeypatch, FakePlex(sections=SECTIONS))
    monkeypatch.setattr(config, "HOSTS", (HOST, SECURE_HOST))
    monkeypatch.setenv("FM_PLEX_TOKEN", "tok")
    # a fresh file nothing has initialised: the first live run died here, on
    # the check table the vitals collector would normally have created
    fresh = str(tmp_path / "fresh.db")

    outcomes = await plex_sync.run_once(fresh)

    assert set(outcomes) == {"syrax", "vhagar"}
    assert all(outcome.history_ok and outcome.inventory_ran for outcome in outcomes.values())
    assert _status(fresh).reachable is True


async def test_an_inventory_round_enriches_only_what_the_listing_left_out(path, monkeypatch):
    fake = _fake(
        monkeypatch,
        FakePlex(
            history=[
                _play(1, "100", viewed_at=NOW - 2 * DAY),
                _play(2, "777", viewed_at=NOW - DAY, title="Vanished"),
            ],
            items={"100": _movie("100", "Heat")},
            sections=SECTIONS,
            section_items={"8": [_movie("100", "Heat")]},
        ),
    )

    outcome = await plex_sync.sync_host(
        HOST, path, now=T0, token="tok", lookback_days=365, inventory_due=True
    )

    assert outcome == plex_sync.HostOutcome(
        history_ok=True, inventory_ran=True, inventory_complete=True
    )
    paths = [p for p, _, _ in fake.requests]
    # the listing came before any metadata request, and metadata was asked
    # only for the one played item the listing did not describe: on a fresh
    # database that is the difference between a few requests and a thousand
    assert paths.index("/library/sections") < paths.index("/library/metadata/777")
    assert [p for p in paths if p.startswith("/library/metadata/")] == ["/library/metadata/777"]
    assert _rows(path, "SELECT rating_key, present FROM plex_items ORDER BY 1") == [
        ("100", 1), ("777", 0),
    ]


async def test_a_request_that_trickles_past_its_budget_is_a_timeout(path, monkeypatch):
    # the transport's timeout is per read; vermithor answered one page's
    # headers at once and then took fifty-nine minutes over the body
    fake = _fake(monkeypatch, FakePlex())
    fake.stall.add("/accounts")
    monkeypatch.setattr(plex_sync, "TIMEOUT", 0.05)

    assert await plex_sync.fetch(HOST, "/accounts", token="tok") == plex_sync.Fetched(
        payload=None, reason="timeout"
    )
    assert (await plex_sync.fetch(HOST, "/", token="tok")).reason == ""


async def test_a_key_that_stalls_alone_is_stubbed_and_the_rest_are_kept(path, monkeypatch):
    fake = _fake(
        monkeypatch,
        FakePlex(
            history=[
                _play(1, "100", viewed_at=NOW - 2 * DAY),
                _play(2, "666", viewed_at=NOW - DAY, title="Stalls"),
                _play(3, "102", viewed_at=NOW - DAY, title="Ronin"),
            ],
            items={
                "100": _movie("100", "Heat"),
                "666": _movie("666", "Stalls"),
                "102": _movie("102", "Ronin"),
            },
        ),
    )
    # any metadata request naming this key trickles past the budget
    fake.stall.add("666")
    monkeypatch.setattr(plex_sync, "TIMEOUT", 0.05)

    check = await plex_sync.sync_history(HOST, path, now=T0, token="tok", lookback_days=365)

    # the batch stalled, so every key was asked for alone; the two that
    # answered are kept, the one that stalled by itself is stubbed, and the
    # pass still counts as having reached the server
    assert check is not None and check.ok
    assert [p for p, _, _ in fake.requests if p.startswith("/library/metadata/")] == [
        "/library/metadata/100,102,666",
        "/library/metadata/100",
        "/library/metadata/102",
        "/library/metadata/666",
    ]
    assert _rows(path, "SELECT rating_key, title, present FROM plex_items ORDER BY 1") == [
        ("100", "Heat", 1), ("102", "Ronin", 1), ("666", "Stalls", 0),
    ]
    # and nothing is asked for again on the next pass
    fake.requests.clear()
    await plex_sync.sync_history(
        HOST, path, now=T0 + timedelta(minutes=5), token="tok", lookback_days=365
    )
    assert [p for p, _, _ in fake.requests if p.startswith("/library/metadata/")] == []


async def test_inventory_rows_carry_the_section_they_were_listed_under(path, monkeypatch):
    # the listing omits librarySectionID on each row, so the never-played
    # list used to show every title with no library beside it
    _fake(
        monkeypatch,
        FakePlex(
            sections=SECTIONS,
            section_items={"8": [_movie("100", "Heat")], "6": [_episode("600", "Smoke")]},
        ),
    )

    await plex_sync.sync_library(HOST, path, now=T0, token="tok")

    assert _rows(path, "SELECT rating_key, section_id FROM plex_items ORDER BY 1") == [
        ("100", "8"), ("600", "6"),
    ]
    with fleet_db.session(path) as connection:
        page = plays.never_played(
            connection, plays.Filters(), hosts=("syrax",), page=1, page_size=10, q="", now=T0
        )
    assert {(row.title, row.library) for row in page.rows} == {
        ("Heat", "Films"), ("Better Call Saul", "Shows"),
    }
