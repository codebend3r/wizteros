import importlib
import os

import responses

# Env required before (re)loading the module — plex reads it at import time.
os.environ.update({"PLEX_TOKEN": "tok", "PLEX_TV_BASE": "http://plex.test"})

from stripe_bridge import plex

importlib.reload(plex)

SERVERS_XML = """<MediaContainer>
  <Server name="Meleys" machineIdentifier="m-1"/>
  <Server name="Vermithor" machineIdentifier="m-2"/>
</MediaContainer>"""

SHARED_M1 = """<MediaContainer machineIdentifier="m-1">
  <SharedServer username="harman" email="Harman@X.com" allLibraries="1" allowSync="1">
    <Section id="1" title="01. Movies" shared="1"/>
    <Section id="2" title="90. Private" shared="1"/>
  </SharedServer>
  <SharedServer username="other" email="other@x.com" allLibraries="0" allowSync="0">
    <Section id="1" title="01. Movies" shared="1"/>
  </SharedServer>
</MediaContainer>"""

SHARED_M2 = """<MediaContainer machineIdentifier="m-2">
  <SharedServer username="other" email="other@x.com" allLibraries="0" allowSync="0">
    <Section id="9" title="02. Anime" shared="1"/>
    <Section id="10" title="03. 4K Movies" shared="0"/>
  </SharedServer>
</MediaContainer>"""


def _mock_plex_tv():
    responses.get("http://plex.test/api/servers", body=SERVERS_XML)
    responses.get("http://plex.test/api/servers/m-1/shared_servers", body=SHARED_M1)
    responses.get("http://plex.test/api/servers/m-2/shared_servers", body=SHARED_M2)


@responses.activate
def test_owned_servers_parses_names_and_ids():
    responses.get("http://plex.test/api/servers", body=SERVERS_XML)
    assert plex.owned_servers() == [
        {"name": "Meleys", "machine_id": "m-1"},
        {"name": "Vermithor", "machine_id": "m-2"},
    ]


@responses.activate
def test_shared_access_matches_email_case_insensitively():
    _mock_plex_tv()
    access = plex.shared_access_for_email("harman@x.com")
    assert access == {
        "Meleys": {
            "all_libraries": True,
            "allow_sync": True,
            "libraries": ["01. Movies", "90. Private"],
        },
    }


@responses.activate
def test_shared_access_skips_unshared_sections():
    _mock_plex_tv()
    access = plex.shared_access_for_email("other@x.com")
    assert access["Vermithor"]["libraries"] == ["02. Anime"]
    assert access["Vermithor"]["all_libraries"] is False
    assert access["Vermithor"]["allow_sync"] is False
    assert access["Meleys"]["libraries"] == ["01. Movies"]


@responses.activate
def test_shared_access_empty_for_unknown_email():
    _mock_plex_tv()
    assert plex.shared_access_for_email("ghost@x.com") == {}


@responses.activate
def test_shared_access_all_groups_every_email_in_one_pass():
    # A shared_servers document lists every account the server is shared with,
    # so the whole roster costs one call per owned server — not per member.
    _mock_plex_tv()
    access = plex.shared_access_all()
    assert set(access) == {"harman@x.com", "other@x.com"}       # keys lowercased
    assert set(access["other@x.com"]) == {"Meleys", "Vermithor"}
    assert access["harman@x.com"]["Meleys"] == {
        "all_libraries": True,
        "allow_sync": True,
        "libraries": ["01. Movies", "90. Private"],
    }
    assert access["other@x.com"]["Vermithor"]["libraries"] == ["02. Anime"]  # shared="0" dropped
    shared_calls = [c for c in responses.calls if "shared_servers" in c.request.url]
    assert len(shared_calls) == 2  # one per owned server, regardless of member count


# --- live sections: the owner's view of each server's libraries -------------

SERVER_M1 = """<MediaContainer>
  <Server name="Meleys" machineIdentifier="m-1">
    <Section id="145283096" key="31" type="show" title="22. Formula 1"/>
    <Section id="137390246" key="8" type="movie" title="04. Movies"/>
  </Server>
</MediaContainer>"""

SERVER_M2 = """<MediaContainer>
  <Server name="Vermithor" machineIdentifier="m-2">
    <Section id="145181324" key="14" type="show" title="01. TV Shows"/>
  </Server>
</MediaContainer>"""


@responses.activate
def test_live_sections_keys_titles_by_server_then_section_id():
    # The section id is what Wizarr stores as a library's external_id, so
    # this is the join the stale-cache check needs.
    responses.get("http://plex.test/api/servers", body=SERVERS_XML)
    responses.get("http://plex.test/api/servers/m-1", body=SERVER_M1)
    responses.get("http://plex.test/api/servers/m-2", body=SERVER_M2)
    assert plex.live_sections() == {
        "Meleys": {"145283096": "22. Formula 1", "137390246": "04. Movies"},
        "Vermithor": {"145181324": "01. TV Shows"},
    }


@responses.activate
def test_live_sections_or_none_swallows_a_plex_tv_failure(caplog):
    responses.get("http://plex.test/api/servers", status=503)
    with caplog.at_level("WARNING", logger="bridge"):
        assert plex.live_sections_or_none() is None
    assert "plex.tv" in caplog.text


def test_live_sections_or_none_is_none_without_a_token(monkeypatch):
    # No token means no plex.tv at all; the caller trusts Wizarr's cache.
    monkeypatch.setattr(plex, "PLEX_TOKEN", "")
    assert plex.live_sections_or_none() is None
