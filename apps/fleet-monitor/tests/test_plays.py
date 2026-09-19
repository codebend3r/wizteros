from datetime import datetime, timedelta, timezone

import pytest

from fleet_monitor import db as fleet_db
from fleet_monitor import plays
from fleet_monitor.probes.plex import (
    Account,
    Device,
    MediaItem,
    PlayEntry,
    Section,
    ServerInfo,
)

T0 = datetime(2026, 9, 18, 12, 0, 0, tzinfo=timezone.utc)
NOW = int(T0.timestamp())
DAY = 86_400

HOSTS = ("meleys", "vermithor", "caraxes", "syrax", "vhagar")


def _at(days_ago: float) -> int:
    return NOW - int(days_ago * DAY)


def _utc(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def _item(
    rating_key: str,
    kind: str = "movie",
    title: str = "Heat",
    *,
    year: int | None = 1995,
    quality: str | None = "1080p",
    parent_rating_key: str | None = None,
    parent_title: str | None = None,
    grandparent_rating_key: str | None = None,
    grandparent_title: str | None = None,
    index: int | None = None,
    parent_index: int | None = None,
    duration_ms: int | None = 6_000_000,
    section_id: str | None = "8",
    added_at: int | None = _at(30),
) -> MediaItem:
    return MediaItem(
        rating_key=rating_key,
        kind=kind,
        title=title,
        parent_rating_key=parent_rating_key,
        parent_title=parent_title,
        parent_index=parent_index,
        grandparent_rating_key=grandparent_rating_key,
        grandparent_title=grandparent_title,
        index=index,
        year=year,
        section_id=section_id,
        duration_ms=duration_ms,
        video_resolution=None,
        width=None,
        height=None,
        quality=quality,
        thumb=f"/library/metadata/{rating_key}/thumb/1",
        added_at=added_at,
    )


def _episode(rating_key: str, show_key: str, show: str, index: int, **kwargs) -> MediaItem:
    return _item(
        rating_key,
        "episode",
        f"{show} {index}",
        year=None,
        parent_rating_key=f"{show_key}s1",
        parent_title="Season 1",
        parent_index=1,
        grandparent_rating_key=show_key,
        grandparent_title=show,
        index=index,
        section_id="6",
        **kwargs,
    )


def _track(rating_key: str, album_key: str, album: str, artist: str, index: int) -> MediaItem:
    return _item(
        rating_key,
        "track",
        f"{album} {index}",
        year=None,
        quality=None,
        parent_rating_key=album_key,
        parent_title=album,
        grandparent_rating_key=f"{album_key}a",
        grandparent_title=artist,
        index=index,
        section_id="21",
        duration_ms=240_000,
    )


def _play(
    history_id: int,
    rating_key: str,
    *,
    kind: str = "movie",
    account_id: int = 1,
    days_ago: float = 1,
    title: str = "played",
    device_id: int | None = 460,
    section_id: str | None = "8",
) -> PlayEntry:
    return PlayEntry(
        history_id=history_id,
        rating_key=rating_key,
        kind=kind,
        title=title,
        section_id=section_id,
        account_id=account_id,
        device_id=device_id,
        viewed_at=_at(days_ago),
    )


@pytest.fixture
def seeded(db):
    """Two hosts, three viewers, a little of everything.

    meleys: Heat (1080p) played by 1 twice and by 7 once; Paddington 2 (4k)
    played by 7; Better Call Saul with two episodes, viewer 1 watched
    episode 1 (4k) twice and episode 2 once, viewer 9 watched episode 1 once;
    a Kid A album with one track played by 7; an sd film played by 1.

    syrax: Heat again (720p) played by 9 a hundred days ago; a never-played
    film in 4k and one in 1080p; a never-played show; a never-played album;
    and a retired film nobody could play any more.
    """
    plays.upsert_server(
        db,
        "meleys",
        info=ServerInfo(friendly_name="Meleys", machine_id="m", version="1.43.4"),
    )
    plays.upsert_server(
        db,
        "syrax",
        info=ServerInfo(friendly_name="Syrax", machine_id="s", version="1.43.4"),
    )
    plays.upsert_accounts(
        db,
        "meleys",
        (
            Account(account_id=1, name="cj", thumb="https://plex.tv/1"),
            Account(account_id=7, name="", thumb=None),
            Account(account_id=9, name="freenow", thumb=None),
        ),
    )
    plays.upsert_accounts(db, "syrax", (Account(account_id=7, name="danny", thumb=None),))
    plays.upsert_devices(
        db,
        "meleys",
        (Device(device_id=460, name="Chrome", platform="Chrome", client_identifier="c"),),
    )
    plays.upsert_sections(
        db,
        "meleys",
        (
            Section(section_id="8", title="04. Movies", kind="movie"),
            Section(section_id="6", title="06. TV Shows", kind="episode"),
            Section(section_id="21", title="20. Music", kind="track"),
        ),
    )
    plays.upsert_sections(
        db,
        "syrax",
        (
            Section(section_id="3", title="Films", kind="movie"),
            Section(section_id="6", title="Shows", kind="episode"),
            Section(section_id="21", title="Music", kind="track"),
        ),
    )
    plays.upsert_items(
        db,
        "meleys",
        (
            _item("100", title="Heat", year=1995, quality="1080p"),
            _item("101", title="Paddington 2", year=2017, quality="4k", duration_ms=9_000_000),
            _item("102", title="Old Film", year=1950, quality="sd"),
            _episode("201", "200", "Better Call Saul", 1, quality="4k"),
            _episode("202", "200", "Better Call Saul", 2, quality="1080p"),
            _track("301", "300", "Kid A", "Radiohead", 1),
        ),
        seen_at=T0,
    )
    plays.upsert_items(
        db,
        "syrax",
        (
            _item("900", title="Heat", year=1995, quality="720p", section_id="3", added_at=_at(2)),
            _item("901", title="Never Watched", year=2020, quality="4k", section_id="3",
                  added_at=_at(1)),
            _item("902", title="Also Never", year=2021, quality="1080p", section_id="3",
                  added_at=None),
            _episode("911", "910", "Untouched Show", 1, quality="720p", added_at=_at(5)),
            _episode("912", "910", "Untouched Show", 2, quality="1080p", added_at=_at(4)),
            _track("921", "920", "Silent Album", "Nobody", 1),
        ),
        seen_at=T0,
    )
    plays.upsert_items(
        db, "syrax", (_item("903", title="Retired Film", year=1999, section_id="3"),),
        seen_at=T0 - timedelta(days=2),
    )
    plays.retire_unseen_items(db, "syrax", seen_before=T0)
    plays.insert_plays(
        db,
        "meleys",
        (
            _play(1, "100", account_id=1, days_ago=1),
            _play(2, "100", account_id=1, days_ago=40),
            _play(3, "100", account_id=7, days_ago=2),
            _play(4, "101", account_id=7, days_ago=3),
            _play(5, "201", kind="episode", account_id=1, days_ago=4, section_id="6"),
            _play(6, "201", kind="episode", account_id=1, days_ago=5, section_id="6"),
            _play(7, "202", kind="episode", account_id=1, days_ago=6, section_id="6"),
            _play(8, "201", kind="episode", account_id=9, days_ago=7, section_id="6"),
            _play(9, "301", kind="track", account_id=7, days_ago=8, section_id="21",
                  device_id=None),
            _play(10, "102", account_id=1, days_ago=9),
        ),
    )
    plays.insert_plays(db, "syrax", (_play(1, "900", account_id=9, days_ago=100, section_id="3"),))
    return db


def _column(connection, sql, params=()):
    """One column of a query, as a list, for the tests that assert on rows the
    store deleted rather than on anything it returns."""
    return [row[0] for row in connection.execute(sql, params).fetchall()]


def _never(connection, filters=plays.Filters(), *, page=1, page_size=50, q="", now=T0):
    return plays.never_played(
        connection, filters, hosts=HOSTS, page=page, page_size=page_size, q=q, now=now
    )


# --- writes ---------------------------------------------------------------


def test_init_db_is_idempotent(db):
    plays.init_db(db)
    plays.init_db(db)

    assert plays.history_cursor(db, "meleys") is None


def test_insert_plays_counts_only_new_rows_and_ignores_a_replay(db):
    first = plays.insert_plays(db, "meleys", (_play(1, "100"), _play(2, "101")))
    again = plays.insert_plays(db, "meleys", (_play(2, "101"), _play(3, "102")))

    assert first == 2
    assert again == 1
    # the same history id on another host is another play: ids are per server
    assert plays.insert_plays(db, "syrax", (_play(1, "100"),)) == 1
    assert plays.insert_plays(db, "syrax", ()) == 0


def test_the_history_cursor_is_per_host_and_survives_a_server_upsert(db):
    plays.set_history_cursor(db, "meleys", 1_700_000_000)
    plays.upsert_server(
        db, "meleys", info=ServerInfo(friendly_name="Meleys", machine_id="m", version="1")
    )

    assert plays.history_cursor(db, "meleys") == 1_700_000_000
    assert plays.history_cursor(db, "syrax") is None


def test_mark_history_records_the_outcome_even_before_the_server_was_ever_identified(db):
    # the very first pass can fail at GET / itself; the failure still has to
    # be visible on /plays/sync, so the row is created here rather than assumed
    plays.mark_history(db, "vhagar", at=T0, ok=False, error="refused")

    status = plays.sync_status(db, hosts=(("vhagar", "https://192.168.50.6:32400"),))
    assert status[0].reachable is False
    assert status[0].last_error == "refused"
    assert status[0].history_synced_at == T0
    assert status[0].friendly_name is None


def test_upsert_items_updates_an_existing_row_and_brings_it_back_to_present(db):
    plays.upsert_items(db, "meleys", (_item("100", quality="720p"),), seen_at=T0 - timedelta(days=1))
    plays.retire_unseen_items(db, "meleys", seen_before=T0)
    plays.upsert_items(db, "meleys", (_item("100", quality="4k"),), seen_at=T0)

    row = db.execute(
        "SELECT quality, present, seen_at FROM plex_items WHERE host = 'meleys'"
    ).fetchone()
    assert row["quality"] == "4k"
    assert row["present"] == 1
    assert row["seen_at"] == T0.isoformat()


def test_retire_unseen_items_marks_only_what_the_run_did_not_see(db):
    plays.upsert_items(db, "meleys", (_item("1"), _item("2")), seen_at=T0 - timedelta(hours=1))
    plays.upsert_items(db, "meleys", (_item("2"),), seen_at=T0)
    plays.upsert_items(db, "syrax", (_item("3"),), seen_at=T0 - timedelta(hours=1))

    retired = plays.retire_unseen_items(db, "meleys", seen_before=T0)

    assert retired == 1
    present = {
        (row["host"], row["rating_key"]): row["present"]
        for row in db.execute("SELECT host, rating_key, present FROM plex_items")
    }
    assert present == {("meleys", "1"): 0, ("meleys", "2"): 1, ("syrax", "3"): 1}


def test_missing_item_keys_names_played_items_with_no_row_and_stubs_silence_them(db):
    plays.insert_plays(
        db,
        "meleys",
        (_play(1, "100", title="Known"), _play(2, "555", title="Gone film"),
         _play(3, "555", title="Gone film"), _play(4, "556", kind="episode", title="Gone ep")),
    )
    plays.upsert_items(db, "meleys", (_item("100"),), seen_at=T0)

    assert plays.missing_item_keys(db, "meleys", limit=10) == ("555", "556")
    assert plays.missing_item_keys(db, "meleys", limit=1) == ("555",)

    plays.stub_missing_items(db, "meleys", ("555", "556"), seen_at=T0)

    assert plays.missing_item_keys(db, "meleys", limit=10) == ()
    stub = db.execute(
        "SELECT kind, title, present, quality FROM plex_items WHERE rating_key = '556'"
    ).fetchone()
    assert (stub["kind"], stub["title"], stub["present"], stub["quality"]) == (
        "episode", "Gone ep", 0, None
    )


def test_upsert_accounts_and_devices_replace_names_in_place(db):
    plays.upsert_accounts(db, "meleys", (Account(account_id=1, name="old", thumb=None),))
    plays.upsert_accounts(db, "meleys", (Account(account_id=1, name="new", thumb="t"),))
    plays.upsert_devices(
        db, "meleys", (Device(device_id=1, name="TV", platform=None, client_identifier=None),)
    )
    plays.upsert_devices(
        db, "meleys", (Device(device_id=1, name="Living room", platform="tvOS",
                              client_identifier="x"),)
    )

    assert tuple(db.execute("SELECT name, thumb FROM plex_accounts").fetchone()) == ("new", "t")
    assert tuple(db.execute("SELECT name, platform FROM plex_devices").fetchone()) == (
        "Living room", "tvOS"
    )


# --- overview -------------------------------------------------------------


def test_overview_totals_and_zero_filled_breakdowns(seeded):
    view = plays.overview(seeded, plays.Filters(), hosts=HOSTS, now=T0)

    # watch time is the played items' own durations: eleven completed plays
    assert view.totals == plays.Totals(plays=11, viewers=3, titles=5, watch_ms=63_240_000)
    assert [(row.kind, row.plays) for row in view.by_kind] == [
        ("movie", 6), ("episode", 4), ("track", 1)
    ]
    # video plays only: the one track is in no bucket; the sd film is "other"
    assert [(row.quality, row.plays) for row in view.by_quality] == [
        ("4k", 4), ("1080p", 4), ("720p", 1), ("other", 1)
    ]
    # every Plex host in the order handed in, zero-filled, position is colour
    assert [(row.host, row.friendly_name, row.plays) for row in view.by_host] == [
        ("meleys", "Meleys", 10),
        ("vermithor", None, 0),
        ("caraxes", None, 0),
        ("syrax", "Syrax", 1),
        ("vhagar", None, 0),
    ]


def test_overview_top_viewers_carry_the_first_non_empty_name_across_hosts(seeded):
    view = plays.overview(seeded, plays.Filters(), hosts=HOSTS, now=T0)

    # 7 is nameless on meleys and "danny" on syrax; 9 is named on meleys only
    assert [(row.account_id, row.name, row.plays) for row in view.top_viewers] == [
        (1, "cj", 6), (7, "danny", 3), (9, "freenow", 2)
    ]


def test_overview_top_titles_are_the_five_most_played_groups_newest_first_on_a_tie(seeded):
    view = plays.overview(seeded, plays.Filters(), hosts=HOSTS, now=T0)

    assert [(row.title, row.plays) for row in view.top_titles] == [
        ("Heat", 4), ("Better Call Saul", 4), ("Paddington 2", 1), ("Kid A", 1), ("Old Film", 1)
    ]


@pytest.mark.parametrize(
    ("days", "bucket"),
    [(7, "day"), (31, "day"), (32, "week"), (180, "week"), (181, "month"), (365, "month")],
)
def test_overview_timeline_bucket_follows_the_window(seeded, days, bucket):
    filters = plays.Filters(since=NOW - days * DAY)

    assert plays.overview(seeded, filters, hosts=HOSTS, now=T0).timeline.bucket == bucket


def test_overview_timeline_all_time_buckets_from_the_earliest_play(seeded):
    # the oldest stored play is 100 days back, so the window is a week one
    view = plays.overview(seeded, plays.Filters(), hosts=HOSTS, now=T0)

    assert view.timeline.bucket == "week"
    assert sum(point.plays for point in view.timeline.points) == 11
    assert all(sum(point.hosts.values()) == point.plays for point in view.timeline.points)
    assert list(view.timeline.points) == sorted(view.timeline.points, key=lambda p: p.start)


def test_overview_timeline_day_points_name_the_local_date_and_split_by_host(seeded):
    view = plays.overview(seeded, plays.Filters(since=_at(3)), hosts=HOSTS, now=T0)

    assert view.timeline.bucket == "day"
    assert [point.plays for point in view.timeline.points] == [1, 1, 1]
    assert all(point.hosts == {"meleys": 1} for point in view.timeline.points)
    assert all(len(point.start) == 10 and point.start[4] == "-" for point in view.timeline.points)


def test_overview_on_an_empty_ledger_is_all_zeros_not_an_error(db):
    view = plays.overview(db, plays.Filters(), hosts=("meleys",), now=T0)

    assert view.totals == plays.Totals(plays=0, viewers=0, titles=0, watch_ms=0)
    assert [row.plays for row in view.by_kind] == [0, 0, 0]
    assert [row.plays for row in view.by_quality] == [0, 0, 0, 0]
    assert [(row.host, row.plays) for row in view.by_host] == [("meleys", 0)]
    assert view.timeline.points == ()
    assert view.timeline.bucket == "month"
    assert view.top_viewers == ()
    assert view.top_titles == ()


# --- filters --------------------------------------------------------------


def test_the_window_is_inclusive_on_its_lower_edge(seeded):
    exact = plays.Filters(since=_at(40))
    just_after = plays.Filters(since=_at(40) + 1)

    assert plays.overview(seeded, exact, hosts=HOSTS, now=T0).totals.plays == 10
    assert plays.overview(seeded, just_after, hosts=HOSTS, now=T0).totals.plays == 9


def test_a_quality_filter_applies_to_video_only(seeded):
    only_4k = plays.overview(seeded, plays.Filters(quality="4k"), hosts=HOSTS, now=T0)
    other = plays.overview(seeded, plays.Filters(quality="other"), hosts=HOSTS, now=T0)

    assert only_4k.totals.plays == 4
    assert [(row.kind, row.plays) for row in only_4k.by_kind] == [
        ("movie", 1), ("episode", 3), ("track", 0)
    ]
    # sd and unknown video, never a track
    assert other.totals.plays == 1
    assert [(row.kind, row.plays) for row in other.by_kind] == [
        ("movie", 1), ("episode", 0), ("track", 0)
    ]
    assert plays.overview(
        seeded, plays.Filters(kind="track", quality="other"), hosts=HOSTS, now=T0
    ).totals.plays == 0


def test_other_quality_includes_a_play_whose_item_is_gone(db):
    plays.insert_plays(db, "meleys", (_play(1, "555", title="Deleted film"),))

    view = plays.overview(db, plays.Filters(quality="other"), hosts=("meleys",), now=T0)

    assert view.totals.plays == 1
    assert view.top_titles[0].title == "Deleted film"
    assert view.top_titles[0].quality is None


def test_host_and_kind_filters_narrow_every_view(seeded):
    syrax = plays.Filters(host="syrax")
    tracks = plays.Filters(kind="track")

    assert plays.overview(seeded, syrax, hosts=HOSTS, now=T0).totals.plays == 1
    assert plays.users(seeded, syrax)[0].account_id == 9
    assert [row.title for row in plays.top_titles(seeded, tracks, metric="plays", limit=5)] == [
        "Kid A"
    ]


# --- users ----------------------------------------------------------------


def test_users_are_ranked_by_plays_with_their_kinds_hosts_and_favourite(seeded):
    users = plays.users(seeded, plays.Filters())

    assert [(u.account_id, u.name, u.plays, u.movies, u.episodes, u.tracks) for u in users] == [
        (1, "cj", 6, 3, 3, 0),
        (7, "danny", 3, 2, 0, 1),
        (9, "freenow", 2, 1, 1, 0),
    ]
    assert users[0].thumb == "https://plex.tv/1"
    assert users[0].hosts == ("meleys",)
    assert users[2].hosts == ("meleys", "syrax")
    assert users[0].last_viewed_at == _utc(_at(1))
    # the group with the most plays for that viewer, alphabetical on a tie
    assert users[0].top_title == "Better Call Saul"
    assert users[1].top_title == "Heat"


def test_a_viewer_nobody_named_keeps_their_id_as_a_name(db):
    plays.insert_plays(db, "meleys", (_play(1, "100", account_id=424242),))

    assert plays.users(db, plays.Filters())[0].name == "account 424242"


# --- user history ---------------------------------------------------------


def test_user_history_is_newest_first_with_titles_devices_and_libraries_joined(seeded):
    page = plays.user_history(seeded, plays.Filters(), account_id=1, page=1, page_size=3)

    assert page.total == 6
    assert page.name == "cj"
    assert page.account_id == 1
    assert [row.title for row in page.rows] == ["Heat", "Better Call Saul 1", "Better Call Saul 1"]
    heat = page.rows[0]
    assert heat.viewed_at == _utc(_at(1))
    assert heat.kind == "movie"
    assert heat.host == "meleys"
    assert heat.quality == "1080p"
    assert heat.device == "Chrome"
    assert heat.library == "04. Movies"
    assert heat.year == 1995
    assert heat.duration_ms == 6_000_000
    episode = page.rows[1]
    assert (episode.grandparent_title, episode.parent_title, episode.parent_index,
            episode.index) == ("Better Call Saul", "Season 1", 1, 1)


def test_user_history_pages_and_honours_the_filters(seeded):
    second = plays.user_history(seeded, plays.Filters(), account_id=1, page=2, page_size=3)
    movies = plays.user_history(seeded, plays.Filters(kind="movie"), account_id=1, page=1,
                                page_size=50)
    nobody = plays.user_history(seeded, plays.Filters(), account_id=4242, page=1, page_size=50)

    assert [row.title for row in second.rows] == ["Better Call Saul 2", "Old Film", "Heat"]
    assert second.page == 2
    assert second.page_size == 3
    assert [row.title for row in movies.rows] == ["Heat", "Old Film", "Heat"]
    assert movies.total == 3
    assert nobody.total == 0
    assert nobody.rows == ()
    assert nobody.name == "account 4242"


def test_user_history_keeps_a_play_whose_item_is_gone(db):
    plays.insert_plays(db, "meleys", (_play(1, "555", title="Deleted film", device_id=None),))

    row = plays.user_history(db, plays.Filters(), account_id=1, page=1, page_size=5).rows[0]

    assert row.title == "Deleted film"
    assert row.quality is None
    assert row.device is None
    assert row.library is None


# --- title history --------------------------------------------------------


def test_title_history_gathers_one_title_across_hosts_with_who_finished_it(seeded):
    page = plays.title_history(seeded, plays.Filters(), key="movie:heat:1995", page=1,
                               page_size=50)

    assert (page.kind, page.title, page.year, page.context) == ("movie", "Heat", 1995, None)
    # the same film on two servers is one title: three viewers, two copies,
    # and the best quality either copy was watched at
    assert (page.total, page.viewers, page.items, page.rewatches) == (4, 3, 2, 1)
    assert page.hosts == ("meleys", "syrax")
    assert page.quality == "1080p"
    assert page.first_viewed_at == _utc(_at(100))
    assert page.last_viewed_at == _utc(_at(1))
    assert [(row.viewer, row.host) for row in page.rows] == [
        ("cj", "meleys"), ("danny", "meleys"), ("cj", "meleys"), ("freenow", "syrax")
    ]
    newest = page.rows[0]
    assert (newest.account_id, newest.quality, newest.device, newest.library) == (
        1, "1080p", "Chrome", "04. Movies"
    )

    # a show gathers its episodes, and moving on to the next one is no rewatch
    show = plays.title_history(seeded, plays.Filters(), key="show:better call saul", page=1,
                               page_size=50)
    assert (show.kind, show.title, show.total, show.items, show.rewatches) == (
        "episode", "Better Call Saul", 4, 2, 1
    )
    assert [(row.parent_index, row.index) for row in show.rows] == [(1, 1), (1, 1), (1, 2), (1, 1)]

    album = plays.title_history(seeded, plays.Filters(), key="album:kid a:radiohead", page=1,
                                page_size=50)
    assert (album.kind, album.title, album.context, album.total) == (
        "track", "Kid A", "Radiohead", 1
    )


def test_title_history_pages_and_stays_named_under_a_filter_that_holds_no_play(seeded):
    second = plays.title_history(seeded, plays.Filters(), key="movie:heat:1995", page=2,
                                 page_size=3)
    assert (second.page, second.page_size, second.total) == (2, 3, 4)
    assert [row.host for row in second.rows] == ["syrax"]

    windowed = plays.title_history(seeded, plays.Filters(since=_at(7)), key="movie:heat:1995",
                                   page=1, page_size=50)
    assert (windowed.total, windowed.viewers, windowed.rewatches) == (2, 2, 0)
    assert windowed.hosts == ("meleys",)

    # a filter the title has no play under still answers with the title: the
    # page holds only the key, and a blank heading would read as a deletion
    empty = plays.title_history(seeded, plays.Filters(host="vhagar"), key="movie:heat:1995",
                                page=1, page_size=50)
    assert (empty.kind, empty.title, empty.year, empty.quality) == ("movie", "Heat", 1995, "1080p")
    assert (empty.total, empty.viewers, empty.rewatches, empty.rows) == (0, 0, 0, ())
    assert (empty.hosts, empty.first_viewed_at, empty.last_viewed_at) == ((), None, None)


def test_title_history_answers_a_key_nothing_in_the_ledger_carries(seeded):
    stale = plays.title_history(seeded, plays.Filters(), key="movie:gone:1970", page=1,
                                page_size=50)

    assert (stale.key, stale.kind, stale.title, stale.total, stale.rows) == (
        "movie:gone:1970", None, "", 0, ()
    )


def test_user_history_rows_carry_the_key_their_title_is_ranked_under(seeded):
    rows = plays.user_history(seeded, plays.Filters(), account_id=1, page=1, page_size=50).rows
    ranked = {title.key for title in plays.top_titles(seeded, plays.Filters(), metric="plays",
                                                      limit=50)}

    # the contract the page links on: every row names a title the rankings
    # know, so a play can be opened as that title's own history
    assert {row.group_key for row in rows} <= ranked
    assert rows[0].group_key == "movie:heat:1995"


# --- one viewing, logged twice --------------------------------------------

SECONDS = 1 / DAY


def _twice(db, rating_key, item, *, kind, gap_seconds, account_id=1, days_ago=1.0):
    """One item and two completions of it by one viewer, `gap_seconds` apart."""
    plays.upsert_items(db, "meleys", (item,), seen_at=T0)
    plays.insert_plays(
        db,
        "meleys",
        (
            _play(1, rating_key, kind=kind, account_id=account_id, days_ago=days_ago),
            _play(2, rating_key, kind=kind, account_id=account_id,
                  days_ago=days_ago - gap_seconds * SECONDS),
        ),
    )


def test_a_viewing_plex_logged_twice_inside_one_runtime_counts_once_everywhere(db):
    # Plex writes a history row each time an item is marked watched, and some
    # clients mark one viewing twice: at the watched threshold, then again at
    # the stop. A 44 minute episode cannot be finished twice in a minute.
    _twice(db, "201", _episode("201", "200", "Better Call Saul", 1, duration_ms=2_677_024),
           kind="episode", gap_seconds=60)
    plays.upsert_sections(db, "meleys", (Section(section_id="6", title="TV", kind="episode"),))

    everything = plays.Filters()
    summary = plays.overview(db, everything, hosts=HOSTS, now=T0)
    assert summary.totals.plays == 1
    assert summary.by_kind[1].plays == 1
    assert sum(point.plays for point in summary.timeline.points) == 1
    title = plays.top_titles(db, everything, metric="plays", limit=5)[0]
    assert (title.plays, title.rewatches, title.top_rewatcher) == (1, 0, None)
    assert plays.top_titles(db, everything, metric="rewatches", limit=5) == ()
    assert plays.users(db, everything)[0].plays == 1
    history = plays.user_history(db, everything, account_id=1, page=1, page_size=10)
    assert history.total == 1
    # the row kept is the first, the moment the item became watched
    assert history.rows[0].viewed_at == _utc(_at(1))
    by_title = plays.title_history(db, everything, key="show:better call saul", page=1,
                                   page_size=10)
    assert (by_title.total, by_title.rewatches, len(by_title.rows)) == (1, 0, 1)
    assert plays.sync_status(db, hosts=(("meleys", "http://meleys:32400"),))[0].plays == 1

    # finishing it again the next day is a real rewatch, and still counts
    plays.insert_plays(db, "meleys", (_play(3, "201", kind="episode", days_ago=0),))
    title = plays.top_titles(db, everything, metric="plays", limit=5)[0]
    assert (title.plays, title.rewatches) == (2, 1)


def test_a_repeat_no_faster_than_the_runtime_is_a_real_play(db):
    # a four minute track on repeat finishes again five minutes later
    _twice(db, "301", _track("301", "300", "Kid A", "Radiohead", 1), kind="track",
           gap_seconds=300)

    assert plays.overview(db, plays.Filters(), hosts=HOSTS, now=T0).totals.plays == 2
    assert plays.top_titles(db, plays.Filters(), metric="plays", limit=5)[0].rewatches == 1


def test_a_second_completion_by_another_viewer_is_not_a_duplicate(db):
    plays.upsert_items(db, "meleys", (_item("100", title="Heat", year=1995),), seen_at=T0)
    plays.insert_plays(
        db,
        "meleys",
        (_play(1, "100", account_id=1, days_ago=1),
         _play(2, "100", account_id=7, days_ago=1 - 30 * SECONDS)),
    )

    assert plays.overview(db, plays.Filters(), hosts=HOSTS, now=T0).totals.plays == 2


def test_a_play_whose_runtime_is_unknown_is_never_collapsed(db):
    # the item is gone from the library, so nothing says how long it was, and
    # a guess would delete a play a viewer may really have made
    plays.insert_plays(
        db,
        "meleys",
        (_play(1, "555", title="Deleted film", days_ago=1),
         _play(2, "555", title="Deleted film", days_ago=1 - 30 * SECONDS)),
    )

    assert plays.overview(db, plays.Filters(), hosts=HOSTS, now=T0).totals.plays == 2


def test_a_chain_of_markings_inside_one_runtime_is_one_play(db):
    plays.upsert_items(db, "meleys", (_item("100", title="Heat", year=1995),), seen_at=T0)
    plays.insert_plays(
        db,
        "meleys",
        (_play(1, "100", days_ago=1),
         _play(2, "100", days_ago=1 - 40 * SECONDS),
         _play(3, "100", days_ago=1 - 3_000 * SECONDS)),
    )

    assert plays.overview(db, plays.Filters(), hosts=HOSTS, now=T0).totals.plays == 1


# --- top titles -----------------------------------------------------------


def test_top_titles_group_a_film_across_hosts_and_count_rewatches_per_viewer_per_item(seeded):
    titles = plays.top_titles(seeded, plays.Filters(), metric="plays", limit=10)
    heat = next(row for row in titles if row.title == "Heat")

    assert heat.kind == "movie"
    assert heat.year == 1995
    assert heat.context is None
    assert heat.plays == 4
    assert heat.viewers == 3
    assert heat.items == 2
    assert heat.hosts == ("meleys", "syrax")
    # viewer 1 watched it twice: one rewatch, and the best played copy is 1080p
    assert heat.rewatches == 1
    assert heat.quality == "1080p"
    assert heat.top_rewatcher == plays.Rewatcher(account_id=1, name="cj", plays=2)
    assert heat.last_viewed_at == _utc(_at(1))
    assert heat.key == "movie:heat:1995"
    assert heat.thumb is not None


def test_top_titles_fold_episodes_into_their_show(seeded):
    show = plays.top_titles(seeded, plays.Filters(kind="episode"), metric="plays", limit=5)[0]

    assert show.title == "Better Call Saul"
    assert show.context is None
    assert show.year is None
    assert show.plays == 4
    assert show.viewers == 2
    assert show.items == 2
    # viewer 1 saw episode 1 twice: one rewatch; ten different episodes would be none
    assert show.rewatches == 1
    assert show.top_rewatcher == plays.Rewatcher(account_id=1, name="cj", plays=2)
    assert show.quality == "4k"
    assert show.key == "show:better call saul"


def test_top_titles_fold_tracks_into_their_album_with_the_artist_as_context(seeded):
    album = plays.top_titles(seeded, plays.Filters(kind="track"), metric="plays", limit=5)[0]

    assert (album.title, album.context, album.quality, album.plays) == (
        "Kid A", "Radiohead", None, 1
    )
    # nobody played any one track twice, so there is no rewatcher to name
    assert album.top_rewatcher is None
    assert album.key == "album:kid a:radiohead"


def test_the_rewatched_metric_keeps_only_groups_with_a_rewatch(seeded):
    titles = plays.top_titles(seeded, plays.Filters(), metric="rewatches", limit=10)

    # equal on rewatches and plays, so the more recently played one leads
    assert [(row.title, row.rewatches) for row in titles] == [
        ("Heat", 1), ("Better Call Saul", 1)
    ]


def test_top_titles_honour_the_limit_and_the_window(seeded):
    assert len(plays.top_titles(seeded, plays.Filters(), metric="plays", limit=2)) == 2
    recent = plays.top_titles(seeded, plays.Filters(since=_at(2)), metric="plays", limit=10)
    assert [(row.title, row.plays) for row in recent] == [("Heat", 2)]


# --- never played ---------------------------------------------------------


def test_never_played_lists_movies_shows_and_albums_newest_added_first(seeded):
    page = _never(seeded)

    assert page.total == 4
    # newest addition first, an unknown date last, title breaks a tie
    assert [(row.kind, row.title, row.host) for row in page.rows] == [
        ("movie", "Never Watched", "syrax"),
        ("show", "Untouched Show", "syrax"),
        ("album", "Silent Album", "syrax"),
        ("movie", "Also Never", "syrax"),
    ]
    movie, show, album, undated = page.rows
    assert (movie.year, movie.quality, movie.library, movie.items) == (2020, "4k", "Films", 1)
    assert movie.added_at == _utc(_at(1))
    assert movie.key == "syrax:movie:901"
    assert movie.context is None
    # a show is as good as its best episode, dated by its newest one
    assert (show.items, show.quality, show.library, show.key) == (2, "1080p", "Shows",
                                                                   "syrax:show:910")
    assert show.added_at == _utc(_at(4))
    assert (album.context, album.items, album.quality, album.key) == (
        "Nobody", 1, None, "syrax:album:920"
    )
    assert undated.added_at is None
    # the retired film is gone from the library and must not be offered to watch
    assert all(row.title != "Retired Film" for row in page.rows)


def test_never_played_within_a_window_means_no_plays_in_that_window(seeded):
    # Old Film was played 9 days ago, the Kid A track 8 days ago, syrax's Heat
    # 100 days ago; Better Call Saul had a play 4 days ago
    week = _never(seeded, plays.Filters(since=_at(7)))
    year = _never(seeded, plays.Filters(since=_at(365)))

    week_titles = {row.title for row in week.rows}
    assert {"Old Film", "Kid A", "Heat"} <= week_titles
    assert "Better Call Saul" not in week_titles
    assert "Paddington 2" not in week_titles
    heat = next(row for row in week.rows if row.title == "Heat")
    assert heat.host == "syrax"
    assert "Old Film" not in {row.title for row in year.rows}


def test_never_played_summary_counts_each_kind_and_movie_qualities(seeded):
    page = _never(seeded)

    assert page.summary.movies == 2
    assert page.summary.shows == 1
    assert page.summary.albums == 1
    assert [(row.quality, row.count) for row in page.summary.by_quality] == [
        ("4k", 1), ("1080p", 1), ("720p", 0), ("other", 0)
    ]
    assert [(row.host, row.count) for row in page.summary.by_host] == [
        ("meleys", 0), ("vermithor", 0), ("caraxes", 0), ("syrax", 4), ("vhagar", 0)
    ]


def test_never_played_filters_by_kind_quality_host_and_search(seeded):
    movies = _never(seeded, plays.Filters(kind="movie"))
    shows = _never(seeded, plays.Filters(kind="episode"))
    albums = _never(seeded, plays.Filters(kind="track"))
    hd = _never(seeded, plays.Filters(quality="1080p"))
    meleys = _never(seeded, plays.Filters(host="meleys"))
    search = _never(seeded, q="NEVER")

    assert {row.kind for row in movies.rows} == {"movie"} and movies.total == 2
    assert [row.title for row in shows.rows] == ["Untouched Show"]
    assert [row.title for row in albums.rows] == ["Silent Album"]
    # a show is as good as its best episode; an album has no quality and is out
    assert {row.title for row in hd.rows} == {"Also Never", "Untouched Show"}
    assert meleys.rows == () and meleys.total == 0 and meleys.summary.movies == 0
    assert {row.title for row in search.rows} == {"Never Watched", "Also Never"}
    # the summary keeps the whole picture while the rows narrow
    assert movies.summary.shows == 1


def test_never_played_pages(seeded):
    first = _never(seeded, page=1, page_size=3)
    second = _never(seeded, page=2, page_size=3)
    beyond = _never(seeded, page=9, page_size=3)

    assert first.total == 4 and len(first.rows) == 3 and first.page == 1 and first.page_size == 3
    assert [row.title for row in second.rows] == ["Also Never"]
    assert beyond.rows == () and beyond.total == 4


# --- sync status ----------------------------------------------------------


def test_sync_status_reports_every_host_handed_in_with_counts_and_outcomes(seeded):
    plays.mark_history(seeded, "meleys", at=T0, ok=True, error=None)
    plays.mark_library(seeded, "meleys", at=T0 - timedelta(hours=1), ok=True, error=None)
    plays.mark_history(seeded, "syrax", at=T0, ok=False, error="timeout")

    status = plays.sync_status(
        seeded,
        hosts=(
            ("meleys", "http://192.168.50.2:32400"),
            ("syrax", "http://192.168.50.5:32400"),
            ("vhagar", "https://192.168.50.6:32400"),
        ),
    )

    meleys, syrax, vhagar = status
    assert meleys == plays.ServerStatus(
        host="meleys",
        friendly_name="Meleys",
        plex_url="http://192.168.50.2:32400",
        reachable=True,
        history_synced_at=T0,
        library_synced_at=T0 - timedelta(hours=1),
        history_since=_utc(_at(40)),
        plays=10,
        items=6,
        last_error=None,
    )
    # the retired film is not in the library any more, so it is not an item
    assert (syrax.reachable, syrax.last_error, syrax.plays, syrax.items) == (
        False, "timeout", 1, 6
    )
    assert syrax.history_since == _utc(_at(100))
    # never synced, never identified: listed, unreachable, empty
    assert vhagar == plays.ServerStatus(
        host="vhagar",
        friendly_name=None,
        plex_url="https://192.168.50.6:32400",
        reachable=False,
        history_synced_at=None,
        library_synced_at=None,
        history_since=None,
        plays=0,
        items=0,
        last_error=None,
    )


def test_a_failed_pass_keeps_the_previous_error_out_of_a_later_success(db):
    plays.mark_history(db, "meleys", at=T0 - timedelta(minutes=5), ok=False, error="refused")
    plays.mark_history(db, "meleys", at=T0, ok=True, error=None)

    status = plays.sync_status(db, hosts=(("meleys", "http://x"),))[0]

    assert status.reachable is True
    assert status.last_error is None


def test_earliest_play_is_none_on_an_empty_ledger_and_per_host_otherwise(seeded):
    assert plays.earliest_play(seeded, host=None) == _at(100)
    assert plays.earliest_play(seeded, host="meleys") == _at(40)
    assert plays.earliest_play(seeded, host="vhagar") is None


def test_the_store_opens_through_the_shared_session(db_path):
    # the API and the sync loop each open their own session; whatever one
    # commits the other reads, which is the whole point of one file
    with fleet_db.session(db_path) as connection:
        plays.init_db(connection)
        plays.insert_plays(connection, "meleys", (_play(1, "100"),))
    with fleet_db.session(db_path) as connection:
        assert plays.users(connection, plays.Filters())[0].plays == 1


def test_top_titles_keep_an_episode_without_a_known_show_as_itself(seeded):
    # three episodes on syrax the library never described: two different
    # shows' "Episode 1", and one the ledger logged with no title at all.
    # Grouped by title they were one row called "Episode 1", which was the
    # top title on the fleet the first time real data was read.
    plays.insert_plays(
        seeded,
        "syrax",
        (
            _play(701, "7001", kind="episode", account_id=1, title="Episode 1", section_id="6"),
            _play(702, "7001", kind="episode", account_id=1, title="Episode 1", section_id="6"),
            _play(703, "7002", kind="episode", account_id=9, title="Episode 1", section_id="6"),
            _play(704, "7003", kind="episode", account_id=9, title="", section_id="6"),
        ),
    )

    titles = plays.top_titles(
        seeded, plays.Filters(kind="episode", host="syrax"), metric="plays", limit=10
    )

    assert [(row.title, row.context, row.plays, row.key) for row in titles] == [
        ("Episode 1", "show not known", 2, "item:syrax:7001"),
        ("Episode 1", "show not known", 1, "item:syrax:7002"),
        ("Untitled", "show not known", 1, "item:syrax:7003"),
    ]
    # the rewatch is real: the same viewer finished the same item twice
    assert titles[0].rewatches == 1
    history = plays.user_history(
        seeded, plays.Filters(host="syrax", kind="episode"), account_id=9, page=1, page_size=5
    )
    assert [row.title for row in history.rows] == ["Untitled", "Episode 1"]


def test_never_played_sorts_an_impossible_addition_date_with_the_undated(seeded):
    # Plex carries a few items stamped decades ahead: QI on meleys says it was
    # added in 2098. Sorted newest first they sat at the top of the list
    # forever, over every title actually added this week.
    plays.upsert_items(
        seeded,
        "syrax",
        (
            _item("930", title="Stamped Ahead", section_id="3", added_at=_at(-26_000)),
            _item("931", title="No Date", section_id="3", added_at=None),
        ),
        seen_at=T0,
    )

    page = _never(seeded)

    assert [row.title for row in page.rows] == [
        "Never Watched",
        "Untouched Show",
        "Silent Album",
        "Stamped Ahead",
        "Also Never",
        "No Date",
    ]
    # the date itself is still reported: it is what the server says, and a row
    # printing a nonsense date at the bottom is more honest than one hiding it
    ahead = next(row for row in page.rows if row.title == "Stamped Ahead")
    assert ahead.added_at == _utc(_at(-26_000))


# --- excluded libraries ---------------------------------------------------


def test_sections_carry_whether_the_page_counts_them(db):
    plays.upsert_sections(
        db,
        "caraxes",
        (
            Section(section_id="2", title="02. Stand Up Comedy", kind="movie"),
            Section(section_id="16", title="99. Tutorials", kind="movie"),
            Section(section_id="20", title="97. Home Videos", kind="movie"),
        ),
        excluded_ids=frozenset({"16", "20"}),
    )

    assert plays.excluded_section_ids(db, "caraxes") == frozenset({"16", "20"})
    # the flag is per host: another server's section 16 is its own question
    assert plays.excluded_section_ids(db, "meleys") == frozenset()


def test_a_section_that_stops_being_excluded_is_counted_again(db):
    sections = (Section(section_id="16", title="99. Tutorials", kind="movie"),)
    plays.upsert_sections(db, "caraxes", sections, excluded_ids=frozenset({"16"}))

    plays.upsert_sections(db, "caraxes", sections)

    assert plays.excluded_section_ids(db, "caraxes") == frozenset()


def test_purging_a_section_takes_its_plays_and_its_items(db):
    plays.upsert_items(
        db,
        "caraxes",
        (
            _item("900", title="How to grep", section_id="16"),
            _item("901", title="Birthday", section_id="20"),
            _item("100", title="Heat", section_id="2"),
        ),
        seen_at=T0,
    )
    plays.insert_plays(
        db,
        "caraxes",
        (
            _play(1, "900", section_id="16"),
            _play(2, "901", section_id="20"),
            _play(3, "100", section_id="2"),
        ),
    )

    purged = plays.purge_sections(db, "caraxes", frozenset({"16", "20"}))

    assert (purged.plays, purged.items) == (2, 2)
    assert _column(db, "SELECT rating_key FROM plex_plays ORDER BY 1") == ["100"]
    assert _column(db, "SELECT rating_key FROM plex_items ORDER BY 1") == ["100"]


def test_purging_takes_a_play_whose_section_only_its_item_knows(db):
    # the ledger does record rows without a librarySectionID; the item behind
    # one still says which library it came from
    plays.upsert_items(db, "caraxes", (_item("900", section_id="16"),), seen_at=T0)
    plays.insert_plays(db, "caraxes", (_play(1, "900", section_id=None),))

    assert plays.purge_sections(db, "caraxes", frozenset({"16"})).plays == 1
    assert _column(db, "SELECT rating_key FROM plex_plays") == []


def test_purging_nothing_touches_nothing(db):
    plays.upsert_items(db, "caraxes", (_item("100"),), seen_at=T0)
    plays.insert_plays(db, "caraxes", (_play(1, "100"),))

    purged = plays.purge_sections(db, "caraxes", frozenset())

    assert (purged.plays, purged.items) == (0, 0)
    assert _column(db, "SELECT rating_key FROM plex_plays") == ["100"]


def test_purging_leaves_another_hosts_rows_alone(db):
    plays.upsert_items(db, "meleys", (_item("900", section_id="16"),), seen_at=T0)
    plays.insert_plays(db, "meleys", (_play(1, "900", section_id="16"),))

    plays.purge_sections(db, "caraxes", frozenset({"16"}))

    assert _column(db, "SELECT rating_key FROM plex_plays") == ["900"]


def test_a_database_written_before_the_rule_gains_the_column(tmp_path):
    # CREATE TABLE IF NOT EXISTS never widens a table, so an existing file
    # would answer every section read with "no such column"
    path = str(tmp_path / "old.db")
    with fleet_db.session(path) as connection:
        connection.execute(
            """
            CREATE TABLE plex_sections (
                host TEXT NOT NULL, section_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
                PRIMARY KEY (host, section_id)
            )
            """
        )
        connection.execute(
            "INSERT INTO plex_sections (host, section_id, title, kind) VALUES (?, ?, ?, ?)",
            ("caraxes", "16", "99. Tutorials", "movie"),
        )

    with fleet_db.session(path) as connection:
        plays.init_db(connection)

        # nothing is excluded by the backfill; the next inventory says so
        assert plays.excluded_section_ids(connection, "caraxes") == frozenset()
