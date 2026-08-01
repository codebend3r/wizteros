import logging
import threading

log = logging.getLogger("bridge.snapshot")


class UpstreamSnapshot:
    """The last known result of a slow fetch, refreshed off the request path.

    get() serves the stored value instantly and only blocks on the very first
    call (nothing cached yet). The app's lifespan loop warms the value at boot
    and re-fetches it on an interval, and refresh_async() re-fetches after
    admin actions that change upstream state. A failed refresh logs and keeps
    serving the previous value.
    """

    def __init__(self, *, fetch):
        self._fetch = fetch
        self._lock = threading.Lock()
        self._value = None
        self._refreshing = False

    def get(self):
        """The cached value, fetching synchronously only when nothing is cached yet."""
        with self._lock:
            value = self._value
        return value if value is not None else self.refresh()

    def refresh(self):
        """Fetch now, store the result, and return it. Raises if the fetch fails."""
        value = self._fetch()
        with self._lock:
            self._value = value
        return value

    def refresh_async(self) -> None:
        """Kick one background refresh; a no-op while another is already running."""
        with self._lock:
            if self._refreshing:
                return
            self._refreshing = True

        def run() -> None:
            """Refresh once, swallowing failures so the previous value keeps serving."""
            try:
                self.refresh()
            except Exception:
                log.exception("background snapshot refresh failed; serving previous value")
            finally:
                with self._lock:
                    self._refreshing = False

        threading.Thread(target=run, daemon=True).start()

    def clear(self) -> None:
        """Drop the cached value so the next get() fetches fresh (used by tests)."""
        with self._lock:
            self._value = None
