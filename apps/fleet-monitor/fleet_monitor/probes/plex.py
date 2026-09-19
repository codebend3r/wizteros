"""Pure parsers for what a Plex Media Server answers over its own API.

Every function here takes JSON already decoded from one Plex response and
returns frozen dataclasses. No clock, no network, no sqlite: the sync loop
stamps and stores, these only read. That is what lets the whole parsing
surface be tested against payloads captured from the real servers without a
server in the loop, the same contract `probes/docker.py` follows.

Shapes were measured on 2026-09-18 against PMS 1.43.4 with the owner token,
with `Accept: application/json`:

- `/status/sessions/history/all` rows carry historyKey, key, ratingKey,
  librarySectionID, title, type, thumb, viewedAt, accountID, deviceID. They
  carry no parent or grandparent titles, so an episode row says "Smoke" and
  nothing about Better Call Saul; that comes from metadata.
- `/library/metadata/{k1,k2,...}` and `/library/sections/{id}/all` answer the
  same item shape, with a `Media` list per item holding videoResolution,
  width, height, bitrate and duration.
- `/accounts` lists id, name, thumb; `/devices` lists id, name, platform,
  clientIdentifier; `/library/sections` lists key, type, title; `/` carries
  friendlyName, machineIdentifier and version.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

Kind = Literal["movie", "episode", "track"]
Quality = Literal["4k", "1080p", "720p", "sd"]

# The three things the ledger logs, and the only three the page is about. A
# clip, a photo or a trailer in the history is skipped, the way Tautulli's own
# `write_session_history` skips them.
KINDS: frozenset[str] = frozenset({"movie", "episode", "track"})

# Plex's `type` number for the leaf item of each library type: what
# `/library/sections/{id}/all?type=N` pages by. Keyed by the leaf kind rather
# than the section type, because the section itself says "show" and "artist"
# and the inventory wants episodes and tracks.
LEAF_TYPE: dict[Kind, int] = {"movie": 1, "episode": 4, "track": 10}

# What a section's own `type` means in leaf terms.
_SECTION_KIND: dict[str, Kind] = {"movie": "movie", "show": "episode", "artist": "track"}

# Best first. A group's quality is its best played version, and the number is
# what SQL orders by.
QUALITY_RANK: dict[Quality, int] = {"4k": 4, "1080p": 3, "720p": 2, "sd": 1}

# Plex's own labels, as the servers actually spell them. Lower-cased before
# lookup because "4K" and "4k" both occur in the wild.
_RESOLUTION_LABELS: dict[str, Quality] = {
    "4k": "4k",
    "1080": "1080p",
    "1080p": "1080p",
    "1080i": "1080p",
    "720": "720p",
    "720p": "720p",
    "sd": "sd",
    "480": "sd",
    "576": "sd",
}


@dataclass(frozen=True, slots=True)
class PlayEntry:
    """One completed view, as the server's own ledger records it."""

    history_id: int
    rating_key: str
    kind: Kind
    title: str
    section_id: str | None
    account_id: int
    device_id: int | None
    viewed_at: int


@dataclass(frozen=True, slots=True)
class MediaItem:
    """One library item, movie, episode or track, with its best version's
    video facts. `quality` is None for a track (no video) and for an item that
    arrived with no Media block at all; the page never invents a resolution."""

    rating_key: str
    kind: Kind
    title: str
    parent_rating_key: str | None
    parent_title: str | None
    parent_index: int | None
    grandparent_rating_key: str | None
    grandparent_title: str | None
    index: int | None
    year: int | None
    section_id: str | None
    duration_ms: int | None
    video_resolution: str | None
    width: int | None
    height: int | None
    quality: Quality | None
    thumb: str | None
    added_at: int | None


@dataclass(frozen=True, slots=True)
class Account:
    account_id: int
    name: str
    thumb: str | None


@dataclass(frozen=True, slots=True)
class Device:
    device_id: int
    name: str
    platform: str | None
    client_identifier: str | None


@dataclass(frozen=True, slots=True)
class Section:
    section_id: str
    title: str
    kind: Kind


@dataclass(frozen=True, slots=True)
class ServerInfo:
    friendly_name: str
    machine_id: str
    version: str


@dataclass(frozen=True, slots=True)
class PageInfo:
    """What a container says about the page it is: how many rows it holds,
    how many exist, and where it starts. The sync loop stops paging on these
    rather than on an empty page, so a server that answers one row short does
    not cost an extra round trip per section."""

    size: int
    total_size: int
    offset: int


def _container(payload: object) -> Mapping[str, object]:
    if not isinstance(payload, Mapping):
        return {}
    container = payload.get("MediaContainer")
    return container if isinstance(container, Mapping) else {}


def _rows(payload: object, key: str) -> list[Mapping[str, object]]:
    rows = _container(payload).get(key)
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, Mapping)]


def _int(value: object) -> int | None:
    """An integer from what Plex sends, which is sometimes a number and
    sometimes the digits as a string. Booleans are not integers here."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return None


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value != "" else None


def _key(value: object) -> str | None:
    """A ratingKey as the string of digits every other endpoint expects.
    Anything that is not digits is not a key the metadata endpoint can
    answer for, so it is dropped rather than carried into a failing url."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value.isdigit():
        return value
    return None


def history_id(history_key: object) -> int | None:
    """The integer at the end of `/status/sessions/history/<id>`, or None."""
    if not isinstance(history_key, str):
        return None
    tail = history_key.rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else None


def page_info(payload: object) -> PageInfo | None:
    """The container's own paging facts. A container with a size but no
    totalSize is a whole answer, so its total is its size."""
    container = _container(payload)
    size = _int(container.get("size"))
    if size is None:
        return None
    total = _int(container.get("totalSize"))
    offset = _int(container.get("offset"))
    return PageInfo(
        size=size,
        total_size=total if total is not None else size,
        offset=offset if offset is not None else 0,
    )


def parse_history(payload: object) -> tuple[PlayEntry, ...]:
    """Completed views from one page of `/status/sessions/history/all`.

    A malformed row is skipped rather than raised on: one bad row must not
    cost the whole page, and a page that fails costs the whole pass for that
    host. Rows without a history id cannot be stored idempotently, rows without
    a digit ratingKey cannot be enriched, and rows of any other kind are not
    plays the page counts; all three are dropped.
    """
    entries = []
    for row in _rows(payload, "Metadata"):
        kind = row.get("type")
        entry_id = history_id(row.get("historyKey"))
        rating_key = _key(row.get("ratingKey"))
        account = _int(row.get("accountID"))
        viewed_at = _int(row.get("viewedAt"))
        if (
            kind not in KINDS
            or entry_id is None
            or rating_key is None
            or account is None
            or viewed_at is None
        ):
            continue
        entries.append(
            PlayEntry(
                history_id=entry_id,
                rating_key=rating_key,
                kind=kind,
                title=_text(row.get("title")) or "",
                section_id=_key(row.get("librarySectionID")),
                account_id=account,
                device_id=_int(row.get("deviceID")),
                viewed_at=viewed_at,
            )
        )
    return tuple(entries)


def quality_bucket(*, video_resolution: str | None, width: int | None) -> Quality | None:
    """The coarse bucket the page groups by.

    Plex's own label wins when it is one it uses; an unlabelled or oddly
    labelled file falls back to its width. Width rather than height on
    purpose: a letterboxed 1080p file is 1920 wide and 796 tall, and judging
    by height would file it under sd. No width and no label is no video, or
    no media block, and stays None rather than becoming sd.
    """
    label = video_resolution.strip().lower() if isinstance(video_resolution, str) else ""
    if label in _RESOLUTION_LABELS:
        return _RESOLUTION_LABELS[label]
    if width is None or width <= 0:
        return None
    if width >= 3000:
        return "4k"
    if width >= 1700:
        return "1080p"
    if width >= 1200:
        return "720p"
    return "sd"


def _best_media(row: Mapping[str, object]) -> Mapping[str, object] | None:
    """The version of an item worth describing it by: the best quality, or the
    first when none has a video track. An item can hold several files (a 4K
    and a 1080p cut of the same episode), and the page reports it as the best
    one, which is also what a viewer picking it in Plex is offered first."""
    media = row.get("Media")
    if not isinstance(media, list):
        return None
    versions = [version for version in media if isinstance(version, Mapping)]
    if not versions:
        return None

    def rank(version: Mapping[str, object]) -> int:
        quality = quality_bucket(
            video_resolution=_text(version.get("videoResolution")),
            width=_int(version.get("width")),
        )
        return QUALITY_RANK[quality] if quality is not None else 0

    return max(versions, key=rank)


def parse_items(payload: object, *, section_id: str | None = None) -> tuple[MediaItem, ...]:
    """Items from `/library/metadata/{keys}` or `/library/sections/{id}/all`.

    Both answer the same shape, with one gap: a section listing omits
    `librarySectionID` on each row, since the section is the one being listed
    (measured 2026-09-18). The caller that paged a section hands its id in as
    `section_id`, and a row's own value still wins where it is present.

    Only the three playable kinds are kept: a section listing paged by leaf
    type never sends anything else, and a metadata batch answered for a show
    or a season is not an item the ledger can hold a play against.
    """
    items = []
    for row in _rows(payload, "Metadata"):
        kind = row.get("type")
        rating_key = _key(row.get("ratingKey"))
        if kind not in KINDS or rating_key is None:
            continue
        version = _best_media(row)
        resolution = _text(version.get("videoResolution")) if version else None
        width = _int(version.get("width")) if version else None
        duration = _int(row.get("duration"))
        if duration is None and version is not None:
            duration = _int(version.get("duration"))
        items.append(
            MediaItem(
                rating_key=rating_key,
                kind=kind,
                title=_text(row.get("title")) or "",
                parent_rating_key=_key(row.get("parentRatingKey")),
                parent_title=_text(row.get("parentTitle")),
                parent_index=_int(row.get("parentIndex")),
                grandparent_rating_key=_key(row.get("grandparentRatingKey")),
                grandparent_title=_text(row.get("grandparentTitle")),
                index=_int(row.get("index")),
                year=_int(row.get("year")),
                section_id=_key(row.get("librarySectionID")) or section_id,
                duration_ms=duration,
                video_resolution=resolution,
                width=width,
                height=_int(version.get("height")) if version else None,
                quality=quality_bucket(video_resolution=resolution, width=width),
                thumb=_text(row.get("thumb")),
                added_at=_int(row.get("addedAt")),
            )
        )
    return tuple(items)


def parse_accounts(payload: object) -> tuple[Account, ...]:
    """Every account the server knows, from `/accounts`.

    The nameless id 0 row is kept: plays are recorded against it on at least
    one server, and a play must never be dropped for want of a name.
    """
    return tuple(
        Account(
            account_id=account_id,
            name=_text(row.get("name")) or "",
            thumb=_text(row.get("thumb")),
        )
        for row in _rows(payload, "Account")
        for account_id in (_int(row.get("id")),)
        if account_id is not None
    )


def parse_devices(payload: object) -> tuple[Device, ...]:
    return tuple(
        Device(
            device_id=device_id,
            name=_text(row.get("name")) or "",
            platform=_text(row.get("platform")),
            client_identifier=_text(row.get("clientIdentifier")),
        )
        for row in _rows(payload, "Device")
        for device_id in (_int(row.get("id")),)
        if device_id is not None
    )


def parse_sections(payload: object) -> tuple[Section, ...]:
    """The libraries the inventory pages: movie, show and artist sections,
    named by the leaf kind they hold. Photo and other libraries hold nothing
    the ledger logs and are skipped."""
    return tuple(
        Section(section_id=section_id, title=_text(row.get("title")) or "", kind=kind)
        for row in _rows(payload, "Directory")
        for section_id in (_key(row.get("key")),)
        for kind in (_SECTION_KIND.get(str(row.get("type"))),)
        if section_id is not None and kind is not None
    )


def parse_server(payload: object) -> ServerInfo | None:
    """Who the server says it is, from `GET /`. None without a machine id: a
    root that cannot identify itself is a proxy page, not a Plex server."""
    container = _container(payload)
    machine_id = _text(container.get("machineIdentifier"))
    if machine_id is None:
        return None
    return ServerInfo(
        friendly_name=_text(container.get("friendlyName")) or "",
        machine_id=machine_id,
        version=_text(container.get("version")) or "",
    )
