import time

import pytest

from stripe_bridge.snapshot import UpstreamSnapshot


def test_get_fetches_once_then_serves_cached():
    calls = []
    snap = UpstreamSnapshot(fetch=lambda: calls.append(1) or {"n": len(calls)})
    assert snap.get() == {"n": 1}
    assert snap.get() == {"n": 1}
    assert len(calls) == 1


def test_refresh_replaces_the_value():
    calls = []
    snap = UpstreamSnapshot(fetch=lambda: calls.append(1) or len(calls))
    assert snap.get() == 1
    assert snap.refresh() == 2
    assert snap.get() == 2


def test_clear_forces_a_refetch():
    calls = []
    snap = UpstreamSnapshot(fetch=lambda: calls.append(1) or len(calls))
    assert snap.get() == 1
    snap.clear()
    assert snap.get() == 2


def test_refresh_propagates_fetch_failures():
    def boom():
        raise RuntimeError("wizarr down")

    snap = UpstreamSnapshot(fetch=boom)
    with pytest.raises(RuntimeError):
        snap.refresh()


def _wait_until(predicate, timeout=2.0):
    """Poll until predicate() is true or the timeout passes (background threads)."""
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert predicate()


def test_refresh_async_failure_keeps_serving_the_previous_value():
    fetches = []

    def fetch():
        fetches.append(1)
        if len(fetches) > 1:
            raise RuntimeError("wizarr down")
        return "first"

    snap = UpstreamSnapshot(fetch=fetch)
    assert snap.get() == "first"
    snap.refresh_async()
    _wait_until(lambda: len(fetches) == 2 and not snap._refreshing)
    assert snap.get() == "first"


def test_refresh_async_updates_the_value():
    fetches = []

    def fetch():
        fetches.append(1)
        return len(fetches)

    snap = UpstreamSnapshot(fetch=fetch)
    assert snap.get() == 1
    snap.refresh_async()
    _wait_until(lambda: len(fetches) == 2 and not snap._refreshing)
    assert snap.get() == 2
