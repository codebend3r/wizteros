import importlib
import os

import responses

# Env required before (re)loading the module — plex reads it at import time.
os.environ.update({"PLEX_TOKEN": "tok", "PLEX_TV_BASE": "http://plex.test"})

import plex  # noqa: E402

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
