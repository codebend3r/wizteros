import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

# Compaction runs in a worker thread while the loop keeps ticking, so two
# writers can now genuinely overlap - they could not while it blocked the loop.
# WAL keeps readers out of the way, but sqlite still serializes writers, and a
# compaction holding the write lock for seconds would otherwise fail a tick
# outright on the 5s default. Waiting is the correct behavior here: the loser
# is a 30 second tick, and losing it entirely is far worse than delaying it.
_BUSY_TIMEOUT_MS = 30_000


def _open(path: str) -> sqlite3.Connection:
    """Open the SQLite file in WAL mode so a read never blocks a tick's write."""
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
    return connection


@contextmanager
def session(path: str) -> Iterator[sqlite3.Connection]:
    """One connection for one unit of work: committed on success, always closed.

    Every store, incidents and rollups call takes the connection rather than
    the path, and this is the only way to get one. That is what makes a unit of
    work atomic: a tick's samples and the check derived from them commit
    together or not at all, and one host's whole container set advances in a
    single transaction instead of one per container.

    It is also the only place that knows how to open the file. Before this,
    three modules imported store._conn and every call opened, configured and
    dropped its own connection, so a single /fleet request cost seventeen of
    them for data one connection answers.
    """
    connection = _open(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()
