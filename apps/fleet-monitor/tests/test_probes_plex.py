import json
from pathlib import Path

import pytest

from fleet_monitor.probes import plex

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


# --- history --------------------------------------------------------------


def test_parse_history_keeps_only_the_three_playable_kinds_with_a_history_id():
    entries = plex.parse_history(_load("plex_history_page.json"))

    # the clip, the row with no historyKey, the non-digit ratingKey and the
    # bare string are all skipped, and none of them raises
    assert [e.history_id for e in entries] == [3132, 3131, 3130]
    assert [e.kind for e in entries] == ["movie", "episode", "track"]


def test_parse_history_reads_every_field_the_ledger_carries():
    first = plex.parse_history(_load("plex_history_page.json"))[0]

    assert first == plex.PlayEntry(
        history_id=3132,
        rating_key="57240",
        kind="movie",
        title="Paddington 2",
        section_id="11",
        account_id=830901987,
        device_id=460,
        viewed_at=1789703560,
    )


def test_parse_history_tolerates_a_missing_device():
    # tracks played through some clients carry no deviceID at all
    track = plex.parse_history(_load("plex_history_page.json"))[2]

    assert track.device_id is None
    assert track.account_id == 13536868


def test_parse_history_on_an_empty_or_malformed_container_is_empty():
    assert plex.parse_history({"MediaContainer": {"size": 0}}) == ()
    assert plex.parse_history({}) == ()
    assert plex.parse_history({"MediaContainer": "nope"}) == ()
    assert plex.parse_history({"MediaContainer": {"Metadata": "nope"}}) == ()


def test_page_info_reads_size_total_and_offset():
    info = plex.page_info(_load("plex_history_page.json"))

    assert info == plex.PageInfo(size=4, total_size=1599, offset=0)


def test_page_info_falls_back_to_size_when_there_is_no_total():
    # a container answered with size only (the metadata batch does this) is a
    # complete answer, so the total is the size
    info = plex.page_info({"MediaContainer": {"size": 3}})

    assert info == plex.PageInfo(size=3, total_size=3, offset=0)


def test_page_info_on_a_malformed_container_is_none():
    assert plex.page_info({}) is None
    assert plex.page_info({"MediaContainer": {"size": "many"}}) is None


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("/status/sessions/history/3132", 3132),
        ("/status/sessions/history/0", 0),
        ("/status/sessions/history/", None),
        ("/status/sessions/history/abc", None),
        ("", None),
        (None, None),
    ],
)
def test_history_id_is_the_trailing_integer(key, expected):
    assert plex.history_id(key) == expected


# --- items ----------------------------------------------------------------


def test_parse_items_reads_a_movie_with_its_media():
    movie = plex.parse_items(_load("plex_metadata_batch.json"))[0]

    assert movie.rating_key == "57240"
    assert movie.kind == "movie"
    assert movie.title == "Paddington 2"
    assert movie.year == 2017
    assert movie.section_id == "11"
    assert movie.duration_ms == 9141664
    assert movie.video_resolution == "1080"
    assert movie.width == 1920
    # letterboxed: the file is 1080p by Plex's own label though only 796 rows tall
    assert movie.height == 796
    assert movie.quality == "1080p"
    assert movie.added_at == 1700000000
    assert movie.thumb == "/library/metadata/57240/thumb/1700000000"
    assert movie.parent_rating_key is None
    assert movie.grandparent_title is None


def test_parse_items_reads_an_episode_with_its_show_and_picks_the_best_version():
    episode = plex.parse_items(_load("plex_metadata_batch.json"))[1]

    assert episode.kind == "episode"
    assert episode.title == "Smoke"
    assert episode.index == 1
    assert episode.parent_index == 4
    assert episode.parent_rating_key == "41200"
    assert episode.parent_title == "Season 4"
    assert episode.grandparent_rating_key == "41000"
    assert episode.grandparent_title == "Better Call Saul"
    # two versions on disk: the item is as good as its best one
    assert episode.quality == "4k"
    assert episode.width == 3840


def test_parse_items_reads_a_track_with_no_video_and_no_quality():
    track = plex.parse_items(_load("plex_metadata_batch.json"))[2]

    assert track.kind == "track"
    assert track.title == "Everything In Its Right Place"
    assert track.parent_title == "Kid A"
    assert track.grandparent_title == "Radiohead"
    assert track.duration_ms == 251000
    assert track.video_resolution is None
    assert track.width is None
    assert track.quality is None


def test_parse_items_reads_a_section_page_and_survives_an_item_with_no_media():
    items = plex.parse_items(_load("plex_section_page.json"))

    assert [i.rating_key for i in items] == ["100", "101"]
    assert items[0].quality == "720p"
    assert items[1].quality is None
    assert items[1].section_id is None
    assert items[1].duration_ms is None


def test_parse_items_skips_kinds_the_ledger_never_logs():
    payload = {
        "MediaContainer": {
            "Metadata": [
                {"ratingKey": "1", "type": "show", "title": "A show"},
                {"ratingKey": "2", "type": "movie", "title": "Kept"},
                {"ratingKey": "x", "type": "movie", "title": "Bad key"},
                {"type": "movie", "title": "No key"},
                "junk",
            ]
        }
    }

    assert [i.title for i in plex.parse_items(payload)] == ["Kept"]


# --- quality --------------------------------------------------------------


@pytest.mark.parametrize(
    ("resolution", "width", "expected"),
    [
        ("4k", 3840, "4k"),
        ("4K", None, "4k"),
        ("1080", 1920, "1080p"),
        ("1080p", None, "1080p"),
        ("1080i", None, "1080p"),
        ("720", 1280, "720p"),
        ("720p", None, "720p"),
        ("sd", 720, "sd"),
        ("480", None, "sd"),
        ("576", None, "sd"),
        # unlabelled files fall back to width, never to height: a letterboxed
        # 1080p file is 796 rows tall and would otherwise read as sd
        (None, 3840, "4k"),
        ("", 3000, "4k"),
        (None, 1920, "1080p"),
        (None, 1700, "1080p"),
        (None, 1280, "720p"),
        (None, 1200, "720p"),
        (None, 720, "sd"),
        (None, 1, "sd"),
        (None, 0, None),
        (None, None, None),
        ("weird", None, None),
        ("weird", 1920, "1080p"),
    ],
)
def test_quality_bucket(resolution, width, expected):
    assert plex.quality_bucket(video_resolution=resolution, width=width) == expected


def test_quality_rank_orders_the_buckets_best_first():
    assert plex.QUALITY_RANK == {"4k": 4, "1080p": 3, "720p": 2, "sd": 1}


# --- accounts, devices, sections, server ----------------------------------


def test_parse_accounts_keeps_every_row_with_an_id_even_the_nameless_one():
    accounts = plex.parse_accounts(_load("plex_accounts.json"))

    assert accounts == (
        plex.Account(account_id=0, name="", thumb=None),
        plex.Account(account_id=1, name="cj", thumb="https://plex.tv/users/1/avatar"),
        plex.Account(
            account_id=830901987,
            name="danny",
            thumb="https://plex.tv/users/830901987/avatar",
        ),
    )


def test_parse_devices_keeps_every_row_with_an_id():
    devices = plex.parse_devices(_load("plex_devices.json"))

    assert devices == (
        plex.Device(device_id=460, name="Chrome", platform="Chrome", client_identifier="abc-460"),
        plex.Device(device_id=12, name="Apple TV", platform="tvOS", client_identifier="abc-12"),
    )


def test_parse_sections_keeps_the_three_playable_library_types():
    sections = plex.parse_sections(_load("plex_sections.json"))

    # the photo library is skipped, so is a directory with no key; a library
    # pointed at two folders carries both, and one pointed at none carries no
    # location rather than a guessed one
    assert sections == (
        plex.Section(
            section_id="13",
            title="01. 4K Movies",
            kind="movie",
            locations=("/volume1/Meleys/Media/4K Movies", "/volume1/Meleys/Vhagar/Media/4K Movies"),
        ),
        plex.Section(
            section_id="6",
            title="03. 4K TV Shows",
            kind="episode",
            locations=("/volume1/Meleys/Media/4K TV",),
        ),
        plex.Section(section_id="21", title="20. Music Lossless", kind="track", locations=()),
    )


def test_leaf_type_is_the_plex_type_number_the_inventory_pages_by():
    assert plex.LEAF_TYPE == {"movie": 1, "episode": 4, "track": 10}


def test_parse_server_reads_the_root_container():
    server = plex.parse_server(_load("plex_root.json"))

    assert server == plex.ServerInfo(
        friendly_name="Meleys",
        machine_id="df9720c0b441af2031064b1a530febd082503325",
        version="1.43.4.10903-e5521bd8c",
    )


def test_parse_server_is_none_without_an_identity():
    assert plex.parse_server({"MediaContainer": {"friendlyName": "x"}}) is None
    assert plex.parse_server({}) is None


def test_parse_items_takes_the_section_from_the_caller_when_the_row_lacks_one():
    # a section listing omits librarySectionID on its rows; a metadata answer
    # carries it, and a row's own value still wins
    listed = {"MediaContainer": {"Metadata": [{"ratingKey": "1", "type": "movie", "title": "A"}]}}
    described = {
        "MediaContainer": {
            "Metadata": [{"ratingKey": "2", "type": "movie", "title": "B", "librarySectionID": 9}]
        }
    }

    assert plex.parse_items(listed, section_id="8")[0].section_id == "8"
    assert plex.parse_items(described, section_id="8")[0].section_id == "9"
    assert plex.parse_items(listed)[0].section_id is None
