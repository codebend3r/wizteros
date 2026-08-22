import math

from fleet_monitor.probes.types import Sample


def number(token: str) -> float | None:
    """A token as a finite float, or None when it is not one.

    Every value a probe reads arrives as an unvalidated string, and one
    malformed token reaching float() raises out of the parser and costs the
    whole host's round. NaN and inf are rejected too: they parse cleanly and
    then poison every average and comparison downstream.

    This is the one numeric gate for every probe. The sibling modules used to
    each hand-roll `token.lstrip("-").isdigit()` before a bare float(), which
    both let inf through and rejected legitimate decimals.
    """
    try:
        value = float(token)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def ratio(*, metric: str, value: float | None, ceiling: float) -> tuple[Sample, ...]:
    """A usage ratio, or nothing when there is no ceiling to divide by.

    Two probes derive a headroom ratio from a reading and its limit, and both
    have to answer the same question about a missing or zero ceiling. Dividing
    is not the interesting part; agreeing on when not to is.
    """
    if value is None or ceiling <= 0:
        return ()
    return (Sample(metric=metric, value=value / ceiling, kind="gauge"),)
