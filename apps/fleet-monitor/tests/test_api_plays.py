from datetime import datetime, timezone

from fastapi.testclient import TestClient

from fleet_monitor import api, collector, plays
from fleet_monitor import db as fleet_db
from fleet_monitor.auth import require_admin
from fleet_monitor.probes.plex import Account, MediaItem, PlayEntry, ServerInfo

T0 = datetime(2026, 9, 18, 12, 0, 0, tzinfo=timezone.utc)
NOW = int(T0.timestamp())
DAY = 86_400

# config order, which is what every by-host list keeps: the portal binds a
# colour per position, the same binding the fleet page uses
PLEX_HOSTS = ["meleys", "vermithor", "caraxes", "syrax", "vhagar"]


def _client(tmp_path, monkeypatch):
    """A client already past the admin gate; the gate itself is tested for
    real in test_auth.py, where these routes are listed as gated."""
    db = str(tmp_path / "fleet.db")
    collector.init_db(db)
    monkeypatch.setenv("FM_DB_PATH", db)
    api.app.dependency_overrides[require_admin] = lambda: None
    return TestClient(api.app), db


def _item(rating_key, *, kind="movie", title="Heat", quality="4k", added_at=NOW - 30 * DAY, **more):
    return MediaItem(
        rating_key=rating_key,
        kind=kind,
        title=title,
        parent_rating_key=more.get("parent_rating_key"),
        parent_title=more.get("parent_title"),
        parent_index=more.get("parent_index"),
        grandparent_rating_key=more.get("grandparent_rating_key"),
        grandparent_title=more.get("grandparent_title"),
        index=more.get("index"),
        year=1995 if kind == "movie" else None,
        section_id="8",
        duration_ms=6_000_000,
        video_resolution=None,
        width=None,
        height=None,
        quality=quality,
        thumb=None,
        added_at=added_at,
    )


def _play(history_id, rating_key, *, viewed_at, kind="movie", title="Heat", account=1):
    return PlayEntry(
        history_id=history_id,
        rating_key=rating_key,
        kind=kind,
        title=title,
        section_id="8",
        account_id=account,
        device_id=None,
        viewed_at=viewed_at,
    )


def _seed(db):
    """One server: a film cj finished twice and Ann once, an episode watched
    over a year ago, and a film nobody has touched."""
    with fleet_db.session(db) as connection:
        plays.upsert_server(
            connection, "meleys",
            info=ServerInfo(friendly_name="Meleys", machine_id="m", version="1.43.4"),
        )
        plays.mark_history(connection, "meleys", at=T0, ok=True, error=None)
        plays.upsert_accounts(
            connection, "meleys",
            [Account(account_id=1, name="cj", thumb=None), Account(account_id=42, name="Ann", thumb=None)],
        )
        plays.upsert_items(
            connection,
            "meleys",
            [
                _item("100"),
                _item(
                    "200", kind="episode", title="Smoke", quality="1080p",
                    grandparent_rating_key="500", grandparent_title="Better Call Saul",
                    parent_rating_key="510", parent_title="Season 4", index=1, parent_index=4,
                ),
                _item("300", title="Never Watched", quality="1080p", added_at=NOW - DAY),
            ],
            seen_at=T0,
        )
        plays.insert_plays(
            connection,
            "meleys",
            [
                _play(1, "100", viewed_at=NOW - 2 * DAY),
                _play(2, "100", viewed_at=NOW - DAY),
                _play(3, "100", viewed_at=NOW - 3 * DAY, account=42),
                _play(4, "200", viewed_at=NOW - 400 * DAY, kind="episode", title="Smoke"),
            ],
        )


def test_overview_answers_zero_filled_buckets_in_config_host_order(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    body = client.get("/plays/overview").json()

    assert body["window"]["days"] == 365
    assert body["window"]["since"] is not None
    assert (body["window"]["host"], body["window"]["kind"], body["window"]["quality"]) == (None,) * 3
    assert body["totals"] == {"plays": 3, "viewers": 2, "titles": 1, "watch_ms": 18_000_000}
    assert body["by_kind"] == [
        {"kind": "movie", "plays": 3}, {"kind": "episode", "plays": 0}, {"kind": "track", "plays": 0},
    ]
    assert [q["quality"] for q in body["by_quality"]] == ["4k", "1080p", "720p", "other"]
    assert body["by_quality"][0]["plays"] == 3
    assert [h["host"] for h in body["by_host"]] == PLEX_HOSTS
    assert body["by_host"][0] == {"host": "meleys", "friendly_name": "Meleys", "plays": 3}
    assert body["by_host"][1] == {"host": "vermithor", "friendly_name": None, "plays": 0}
    assert body["timeline"]["bucket"] == "month"
    assert sum(point["plays"] for point in body["timeline"]["points"]) == 3
    assert all(point["hosts"] == {"meleys": point["plays"]} for point in body["timeline"]["points"])
    assert body["top_viewers"] == [
        {"account_id": 1, "name": "cj", "plays": 2}, {"account_id": 42, "name": "Ann", "plays": 1},
    ]
    assert [(t["title"], t["plays"], t["rewatches"]) for t in body["top_titles"]] == [("Heat", 3, 1)]


def test_days_zero_means_all_time(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    body = client.get("/plays/overview?days=0").json()

    assert body["window"] == {"days": 0, "since": None, "host": None, "kind": None, "quality": None}
    assert body["totals"]["plays"] == 4
    assert body["by_kind"][1] == {"kind": "episode", "plays": 1}


def test_filters_narrow_the_read_and_a_bad_filter_is_a_client_error(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    narrowed = client.get("/plays/overview?host=meleys&kind=movie&quality=4k").json()
    assert narrowed["totals"]["plays"] == 3
    assert narrowed["window"] == {
        "days": 365, "since": narrowed["window"]["since"], "host": "meleys", "kind": "movie",
        "quality": "4k",
    }
    assert client.get("/plays/overview?host=syrax").json()["totals"]["plays"] == 0
    assert client.get("/plays/overview?quality=other").json()["totals"]["plays"] == 0

    # the fleet is known, so a host nobody has is refused rather than answered
    # for nobody; the enumerations and the bounds likewise
    assert client.get("/plays/overview?host=nope").status_code == 422
    assert client.get("/plays/overview?kind=clip").status_code == 422
    assert client.get("/plays/overview?quality=hd").status_code == 422
    assert client.get("/plays/overview?days=-1").status_code == 422
    assert client.get("/plays/overview?days=99999").status_code == 422


def test_users_and_one_viewers_paged_history(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    users = client.get("/plays/users").json()["users"]
    assert [(u["account_id"], u["name"], u["plays"], u["movies"], u["episodes"]) for u in users] == [
        (1, "cj", 2, 2, 0), (42, "Ann", 1, 1, 0),
    ]
    assert users[0]["hosts"] == ["meleys"]
    assert users[0]["top_title"] == "Heat"
    assert users[0]["last_viewed_at"].startswith("2026-09-17")

    first = client.get("/plays/users/1/history?page=1&page_size=1").json()
    assert (first["account_id"], first["name"], first["total"], first["page"], first["page_size"]) == (
        1, "cj", 2, 1, 1,
    )
    row = first["rows"][0]
    assert (row["title"], row["kind"], row["quality"], row["host"], row["year"]) == (
        "Heat", "movie", "4k", "meleys", 1995,
    )
    assert row["viewed_at"].startswith("2026-09-17")
    second = client.get("/plays/users/1/history?page=2&page_size=1").json()
    assert len(second["rows"]) == 1 and second["rows"][0]["viewed_at"].startswith("2026-09-16")

    # the window applies here too: the episode is outside the year
    assert client.get("/plays/users/1/history?days=0").json()["total"] == 3
    # a viewer nobody has named, or nobody at all, is still an answer
    assert client.get("/plays/users/999/history").json() == {
        "account_id": 999, "name": "account 999", "total": 0, "page": 1, "page_size": 50, "rows": [],
    }
    assert client.get("/plays/users/1/history?page_size=0").status_code == 422
    assert client.get("/plays/users/1/history?page=0").status_code == 422


def test_top_titles_echo_their_metric_and_rewatches_omit_the_unrewatched(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    top = client.get("/plays/top?metric=plays&limit=5&days=0").json()
    assert top["metric"] == "plays"
    assert [t["title"] for t in top["titles"]] == ["Heat", "Better Call Saul"]
    heat = top["titles"][0]
    assert (
        heat["kind"], heat["year"], heat["quality"], heat["plays"], heat["viewers"], heat["items"],
        heat["rewatches"], heat["context"],
    ) == ("movie", 1995, "4k", 3, 2, 1, 1, None)
    assert heat["top_rewatcher"] == {"account_id": 1, "name": "cj", "plays": 2}
    assert heat["hosts"] == ["meleys"]
    assert heat["last_viewed_at"].startswith("2026-09-17")

    rewatched = client.get("/plays/top?metric=rewatches&days=0").json()
    assert rewatched["metric"] == "rewatches"
    assert [t["title"] for t in rewatched["titles"]] == ["Heat"]

    assert client.get("/plays/top?metric=views").status_code == 422
    assert client.get("/plays/top?limit=0").status_code == 422
    assert client.get("/plays/top?limit=101").status_code == 422


def test_one_titles_whole_history_with_who_finished_it(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    body = client.get("/plays/title?key=movie:heat:1995&days=0").json()

    assert (body["key"], body["kind"], body["title"], body["year"]) == (
        "movie:heat:1995", "movie", "Heat", 1995,
    )
    assert (body["total"], body["viewers"], body["items"], body["rewatches"]) == (3, 2, 1, 1)
    assert (body["page"], body["page_size"], body["hosts"]) == (1, 50, ["meleys"])
    assert body["last_viewed_at"].startswith("2026-09-17")
    assert body["first_viewed_at"].startswith("2026-09-15")
    assert [(row["viewer"], row["account_id"]) for row in body["rows"]] == [
        ("cj", 1), ("cj", 1), ("Ann", 42),
    ]
    assert body["rows"][0]["viewed_at"].startswith("2026-09-17")

    # the key a viewer's row carries is the key that opens this page
    row = client.get("/plays/users/1/history").json()["rows"][0]
    assert row["group_key"] == "movie:heat:1995"

    paged = client.get("/plays/title?key=movie:heat:1995&days=0&page=2&page_size=2").json()
    assert (paged["page"], paged["total"], len(paged["rows"])) == (2, 3, 1)

    # the window narrows the rows, and the title stays named without them
    narrowed = client.get("/plays/title?key=show:better call saul").json()
    assert (narrowed["title"], narrowed["kind"], narrowed["total"]) == (
        "Better Call Saul", "episode", 0,
    )
    assert narrowed["rows"] == []

    # a key nothing answers to is a stale link, not an error
    stale = client.get("/plays/title?key=movie:gone:1970").json()
    assert (stale["kind"], stale["title"], stale["total"], stale["rows"]) == (None, "", 0, [])

    assert client.get("/plays/title").status_code == 422
    assert client.get("/plays/title?key=").status_code == 422
    assert client.get(f"/plays/title?key={'x' * 501}").status_code == 422


def test_never_played_lists_what_has_no_play_in_the_window(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)

    body = client.get("/plays/never-played").json()

    # the show's one episode was watched over a year ago, so inside the year
    # it counts as never played; the film nobody touched always does
    assert (body["summary"]["movies"], body["summary"]["shows"], body["summary"]["albums"]) == (1, 1, 0)
    assert [q["quality"] for q in body["summary"]["by_quality"]] == ["4k", "1080p", "720p", "other"]
    assert body["summary"]["by_quality"][1] == {"quality": "1080p", "count": 1}
    assert [h["host"] for h in body["summary"]["by_host"]] == PLEX_HOSTS
    assert body["summary"]["by_host"][0] == {"host": "meleys", "count": 2}
    assert (body["total"], body["page"], body["page_size"]) == (2, 1, 50)
    assert [(r["kind"], r["title"], r["items"]) for r in body["rows"]] == [
        ("movie", "Never Watched", 1), ("show", "Better Call Saul", 1),
    ]
    assert body["rows"][0]["added_at"].startswith("2026-09-17")
    assert body["rows"][0]["quality"] == "1080p"

    all_time = client.get("/plays/never-played?days=0&kind=movie").json()
    assert all_time["summary"]["shows"] == 0
    assert [r["title"] for r in all_time["rows"]] == ["Never Watched"]

    search = client.get("/plays/never-played?q=saul").json()
    assert [r["title"] for r in search["rows"]] == ["Better Call Saul"]
    assert client.get("/plays/never-played?q=" + "x" * 201).status_code == 422


def test_sync_reports_every_plex_host_and_the_lookback(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    _seed(db)
    monkeypatch.setenv("FM_PLEX_LOOKBACK_DAYS", "730")

    body = client.get("/plays/sync").json()

    assert body["lookback_days"] == 730
    assert [s["host"] for s in body["servers"]] == PLEX_HOSTS
    meleys = body["servers"][0]
    assert (meleys["friendly_name"], meleys["reachable"], meleys["plays"], meleys["items"]) == (
        "Meleys", True, 4, 3,
    )
    assert meleys["plex_url"] == "http://192.168.50.2:32400"
    assert meleys["history_synced_at"].startswith("2026-09-18T12:00:00")
    assert meleys["library_synced_at"] is None
    assert meleys["history_since"].startswith("2025-08-14")
    assert meleys["last_error"] is None
    # a host no pass has reached yet is listed, unreachable and empty, rather
    # than left out: absence from the page would read as absence from the fleet
    assert body["servers"][4] == {
        "host": "vhagar",
        "friendly_name": None,
        "plex_url": "https://192.168.50.6:32400",
        "reachable": False,
        "history_synced_at": None,
        "library_synced_at": None,
        "history_since": None,
        "plays": 0,
        "items": 0,
        "last_error": None,
    }


def test_the_routes_answer_json_on_an_empty_ledger(tmp_path, monkeypatch):
    # first boot: the tables exist and nothing is in them, and every route
    # still answers rather than tripping over a missing row
    client, _ = _client(tmp_path, monkeypatch)

    assert client.get("/plays/overview").json()["totals"]["plays"] == 0
    assert client.get("/plays/users").json() == {"users": []}
    assert client.get("/plays/top").json() == {"metric": "plays", "titles": []}
    assert client.get("/plays/title?key=movie:heat:1995").json()["total"] == 0
    assert client.get("/plays/never-played").json()["total"] == 0
    assert all(not s["reachable"] for s in client.get("/plays/sync").json()["servers"])
