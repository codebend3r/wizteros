import logging
from collections.abc import Iterable

log = logging.getLogger("fleet.tasks")


def log_raised[T](label: str, outcomes: Iterable[T | BaseException]) -> tuple[T, ...]:
    """Name any job that raised and return only the ones that produced a value.

    gather(return_exceptions=True) is what keeps one wedged host from taking a
    whole round down, but a swallowed exception is a silent hole, so every one
    of them is logged here before being dropped.

    Only `Exception` is swallowed. A BaseException that is not one is the
    process being torn down - CancelledError above all - and absorbing that
    makes graceful shutdown impossible, so it is re-raised instead.

    Shared by the vitals loop and the play-history loop, which run side by side
    in one process and must treat a torn-down task the same way.
    """
    collected = tuple(outcomes)
    fatal = next(
        (
            item
            for item in collected
            if isinstance(item, BaseException) and not isinstance(item, Exception)
        ),
        None,
    )
    if fatal is not None:
        raise fatal
    raised = tuple(item for item in collected if isinstance(item, Exception))
    if raised:
        log.warning(
            "%s: %d job(s) raised: %s", label, len(raised), "; ".join(map(repr, raised))
        )
    return tuple(item for item in collected if not isinstance(item, Exception))
