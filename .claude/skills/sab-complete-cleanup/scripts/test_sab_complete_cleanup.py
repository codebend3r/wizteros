"""Tests for the SABnzbd Complete cleanup delete rule. Run with python3 -m unittest."""
import logging
import os
import tempfile
import unittest

from sab_complete_cleanup import (
    TV_TAG,
    Decision,
    Entry,
    active_names,
    entry_name,
    host_path,
    judge,
    scan,
    sweep,
)

OLD, CUTOFF, NEW = 1000.0, 2000.0, 3000.0
IN_LIBRARY = {"title": "Ghost in the Shell", "movieFile": {"path": "/Meleys/Movies/Ghost in the Shell (1995)/g.mkv"}}
NOT_IMPORTED = {"title": "Titicut Follies", "movieFile": None}


def entry(name, newest=OLD, is_link=False, size=0):
    """An Entry whose path is irrelevant to judge()."""
    return Entry(name, "/c/" + name, is_link, size, newest)


def movies(table):
    """A find_movie that answers from a dict and fails the test on any other title."""
    return lambda name: table[name]


def quiet_log():
    """A logger that swallows output, so a sweep test prints nothing."""
    log = logging.getLogger("test-sweep")
    log.handlers = [logging.NullHandler()]
    log.propagate = False
    return log


class TvTagTest(unittest.TestCase):
    def test_episode_and_season_names_are_tv(self):
        names = [
            "Frasier.S11E02.1080p.BluRay.x264-BORDURE",
            "Gone 2026 S01E05 1080p AMZN WEB-DL DDP2 0 H 264-RAWR",
            "The.Office.S02.COMPLETE.1080p",
            "show_s3e04_720p",
            "S01E01.Pilot.mkv",
        ]
        for name in names:
            self.assertTrue(TV_TAG.search(name), name)

    def test_near_misses_are_not_tv(self):
        names = [
            "Ghost.in.the.Shell.1995.US.REPACK.4K.HDR.DV.2160p.BDRemux",
            "S.W.A.T.2003.1080p.BluRay",
            "Se7en.1995.2160p.UHD",
            "Mission.Impossible.Dead.Reckoning.2023.S1mple-GRP",
            "Jessie.Reyez-A.LITTLE.VENGEANCE-16BIT-WEB-FLAC-2026-ENRICH",
            "Sicario.2015.DTS-HD.MA.5.1",
        ]
        for name in names:
            self.assertFalse(TV_TAG.search(name), name)


class JudgeTest(unittest.TestCase):
    def test_tv_past_the_grace_is_deleted_without_asking_radarr(self):
        self.assertEqual(judge(entry("Frasier.S11E02.x264"), set(), CUTOFF, movies({})), Decision(True, "tv"))

    def test_movie_radarr_has_a_file_for_is_deleted_with_the_library_path(self):
        name = "Ghost.in.the.Shell.1995.2160p"
        decision = judge(entry(name), set(), CUTOFF, movies({name: IN_LIBRARY}))
        self.assertEqual(decision, Decision(True, "in-library", IN_LIBRARY["movieFile"]["path"]))

    def test_movie_radarr_tracks_without_a_file_is_kept(self):
        name = "Titicut.Follies.1967.1080p"
        self.assertEqual(judge(entry(name), set(), CUTOFF, movies({name: NOT_IMPORTED})), Decision(False, "not-imported"))

    def test_movie_with_no_movie_file_key_is_kept(self):
        name = "Odd.Movie.2001"
        self.assertEqual(judge(entry(name), set(), CUTOFF, movies({name: {"title": "Odd"}})), Decision(False, "not-imported"))

    def test_unmatched_name_is_kept(self):
        name = "Lil.Baby-FRESH-16BIT-WEBFLAC-2026"
        self.assertEqual(judge(entry(name), set(), CUTOFF, movies({name: None})), Decision(False, "unknown-movie"))

    def test_symlink_active_and_new_entries_are_kept_before_any_rule(self):
        tv = "Frasier.S11E02.x264"
        self.assertEqual(judge(entry(tv, is_link=True), set(), CUTOFF, movies({})), Decision(False, "symlink"))
        self.assertEqual(judge(entry(tv), {tv}, CUTOFF, movies({})), Decision(False, "active"))
        self.assertEqual(judge(entry(tv, newest=NEW), set(), CUTOFF, movies({})), Decision(False, "too-new"))


class ActiveNamesTest(unittest.TestCase):
    def test_unfinished_slots_count_by_storage_folder_and_by_name(self):
        slots = [
            {"status": "Completed", "name": "Done.S01E01", "storage": "/downloads/Done.S01E01/x.mkv"},
            {"status": "Failed", "name": "Broken.S01E02", "storage": ""},
            {"status": "Extracting", "name": "Job.Name", "storage": "/downloads/Renamed.Folder.1/x.mkv"},
            {"status": "Queued", "name": "Waiting.S01E03"},
        ]
        self.assertEqual(active_names(slots, "/downloads"), {"Job.Name", "Renamed.Folder.1", "Waiting.S01E03"})

    def test_storage_outside_complete_names_nothing(self):
        self.assertEqual(entry_name("/incomplete-downloads/Job/x.mkv", "/downloads"), "")
        self.assertEqual(entry_name("/downloads", "/downloads"), "")
        self.assertEqual(entry_name("/downloads/Job/sub/x.mkv", "/downloads/"), "Job")


class HostPathTest(unittest.TestCase):
    MOUNTS = {"/config": "/volume1/docker/essoz/SABnzbd/config", "/downloads": "/volume1/docker/essoz/downloads/Complete"}

    def test_maps_through_the_matching_mount(self):
        self.assertEqual(host_path(self.MOUNTS, "/downloads"), "/volume1/docker/essoz/downloads/Complete")
        self.assertEqual(host_path(self.MOUNTS, "/config/sabnzbd.ini"), "/volume1/docker/essoz/SABnzbd/config/sabnzbd.ini")

    def test_a_prefix_that_is_not_a_path_component_does_not_match(self):
        with self.assertRaises(RuntimeError):
            host_path(self.MOUNTS, "/downloads-other/x")

    def test_the_longest_mount_wins(self):
        mounts = {"/data": "/a", "/data/complete": "/b"}
        self.assertEqual(host_path(mounts, "/data/complete/x"), "/b/x")


class ScanTest(unittest.TestCase):
    def test_sizes_count_files_and_newest_sees_nested_items(self):
        with tempfile.TemporaryDirectory() as root:
            release = os.path.join(root, "Release.S01E01")
            os.makedirs(os.path.join(release, "Subs"))
            with open(os.path.join(release, "x.mkv"), "wb") as handle:
                handle.write(b"0" * 10)
            os.utime(os.path.join(release, "x.mkv"), (OLD, OLD))
            os.utime(os.path.join(release, "Subs"), (NEW, NEW))
            os.utime(release, (OLD, OLD))
            os.symlink(release, os.path.join(root, "Link"))
            entries = {found.name: found for found in scan(root)}
        self.assertEqual(entries["Release.S01E01"].size, 10)
        self.assertEqual(entries["Release.S01E01"].newest, NEW)
        self.assertTrue(entries["Link"].is_link)
        self.assertFalse(entries["Release.S01E01"].is_link)


class SweepTest(unittest.TestCase):
    ENTRIES = [entry("Gone.S01E01", size=5), entry("Keep.Me")]

    def decide(self, found):
        return Decision(True, "tv") if found.name == "Gone.S01E01" else Decision(False, "unknown-movie")

    def test_a_dry_run_deletes_nothing_and_still_tallies(self):
        deleted = []
        self.assertEqual(sweep(self.ENTRIES, self.decide, False, quiet_log(), deleted.append), (1, 0))
        self.assertEqual(deleted, [])

    def test_apply_deletes_only_what_judge_deletes(self):
        deleted = []
        self.assertEqual(sweep(self.ENTRIES, self.decide, True, quiet_log(), deleted.append), (1, 0))
        self.assertEqual(deleted, ["/c/Gone.S01E01"])

    def test_a_failed_delete_is_counted_and_the_sweep_goes_on(self):
        def refuse(path):
            raise OSError("busy")

        self.assertEqual(sweep(self.ENTRIES, self.decide, True, quiet_log(), refuse), (0, 1))


if __name__ == "__main__":
    unittest.main()
