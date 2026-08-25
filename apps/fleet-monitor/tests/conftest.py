import pytest

from fleet_monitor import api, incidents, rollups, store
from fleet_monitor import db as fleet_db


@pytest.fixture
def db_path(tmp_path):
    """A path to a fresh, empty database file."""
    return str(tmp_path / "fleet.db")


@pytest.fixture
def db(db_path):
    """An initialized connection, for tests that exercise one unit of work.

    The store, incidents and rollups calls all take a connection now, so a test
    that used to open its own file per call shares this one. Everything written
    through it is visible to it before the commit at teardown, which is what
    makes a test read like the single session it is standing in for.

    Tests that cross sessions on purpose - anything driving the collector or
    the API, which take a path and open their own - take `db_path` instead.
    """
    with fleet_db.session(db_path) as connection:
        store.init_db(connection)
        rollups.init_db(connection)
        incidents.init_db(connection)
        yield connection


@pytest.fixture(autouse=True)
def _clear_dependency_overrides():
    """Undo any auth override a test installed on the shared app object.

    `api.app` is module-level, so an override outlives the test that set it and
    would silently unlock the suite's own auth tests. Cleared here rather than
    in each test so forgetting cannot be a way to weaken them.
    """
    yield
    api.app.dependency_overrides.clear()
